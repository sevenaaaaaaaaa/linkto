package com.linktomobile

import android.content.Context
import android.content.Intent
import android.content.ClipData
import android.app.AlarmManager
import android.app.NotificationManager
import android.os.Build
import android.net.Uri
import android.provider.Settings
import com.facebook.react.bridge.Arguments
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.FileProvider
import java.io.File
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import android.util.Base64

/**
 * LinkToCore —— 移动端原生能力模块（v0.3.0 原生改造）
 *
 * 全部安全原语走平台原生实现，不再经过 JS 层软实现：
 *  - sha256Hex     : java.security.MessageDigest（SHA-256）
 *  - randomB64     : java.security.SecureRandom（密码学安全随机，替代 Math.random）
 *  - pbkdf2Hex     : PBKDF2WithHmacSHA256（守卫验证器 KDF，抗离线暴力）
 *  - haptic        : VibrationEffect.createPredefined 平台原生触感（点击/重击/告警）
 */
class LinkToCoreModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

  override fun getName(): String = "LinkToCore"

  private val mainHandler = Handler(Looper.getMainLooper())

  @ReactMethod
  fun scheduleReminder(id: String, title: String, at: Double, promise: Promise) {
    try {
      if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) { promise.reject("REMINDER_PERMISSION", "请在系统设置中允许 LinkTo 通知"); return }
      ReminderReceiver.channel(ctx)
      ctx.getSharedPreferences("linkto.reminders", Context.MODE_PRIVATE).edit().putLong(id, at.toLong()).apply()
      ReminderReceiver.schedule(ctx, id, at.toLong())
      promise.resolve(true)
    } catch (e: Exception) { promise.reject("REMINDER_ERR", e.message, e) }
  }

  @ReactMethod
  fun cancelReminder(id: String, promise: Promise) {
    (ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(ReminderReceiver.pending(ctx, id))
    ctx.getSharedPreferences("linkto.reminders", Context.MODE_PRIVATE).edit().remove(id).apply()
    NotificationManagerCompat.from(ctx).cancel(id, 1)
    promise.resolve(true)
  }

  @ReactMethod
  fun cancelAllReminders(promise: Promise) {
    val prefs = ctx.getSharedPreferences("linkto.reminders", Context.MODE_PRIVATE)
    for (id in prefs.all.keys) (ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager).cancel(ReminderReceiver.pending(ctx, id))
    prefs.edit().clear().apply()
    ctx.getSharedPreferences("linkto.navigation", Context.MODE_PRIVATE).edit().clear().apply()
    NotificationManagerCompat.from(ctx).cancelAll()
    promise.resolve(true)
  }

  @ReactMethod
  fun takeReminder(promise: Promise) {
    val prefs = ctx.getSharedPreferences("linkto.navigation", Context.MODE_PRIVATE)
    val id = prefs.getString("workItemId", null)
    prefs.edit().remove("workItemId").apply()
    promise.resolve(id)
  }

  @ReactMethod
  fun reminderStatus(promise: Promise) {
    val status = Arguments.createMap()
    status.putBoolean("authorized", NotificationManagerCompat.from(ctx).areNotificationsEnabled())
    status.putBoolean("exact", Build.VERSION.SDK_INT < 31 || (ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager).canScheduleExactAlarms())
    promise.resolve(status)
  }

  @ReactMethod
  fun openReminderSettings(promise: Promise) {
    val intent = if (Build.VERSION.SDK_INT >= 31) Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:" + ctx.packageName)) else Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName)
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    ctx.startActivity(intent); promise.resolve(true)
  }

  @ReactMethod
  fun clearAttachments(promise: Promise) {
    File(ctx.cacheDir, "attachments").deleteRecursively()
    promise.resolve(true)
  }

  @ReactMethod
  fun openAttachment(filename: String, data: String, type: String, share: Boolean, promise: Promise) {
    try {
      val bytes = Base64.decode(data, Base64.DEFAULT)
      if (bytes.size > 15 * 1024 * 1024) throw IllegalArgumentException("附件超过 15MB")
      val root = File(ctx.cacheDir, "attachments").apply { mkdirs() }
      root.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 86400000 }?.forEach { it.deleteRecursively() }
      val folder = File(root, java.util.UUID.randomUUID().toString()).apply { mkdirs() }
      val safeName = File(filename).name.takeIf { it.isNotBlank() && it != "." && it != ".." } ?: "attachment.bin"
      val file = File(folder, safeName).apply { writeBytes(bytes) }
      val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".attachments", file)
      val intent = Intent(if (share) Intent.ACTION_SEND else Intent.ACTION_VIEW).apply {
        setDataAndType(uri, type.ifBlank { "application/octet-stream" })
        if (share) putExtra(Intent.EXTRA_STREAM, uri)
        clipData = ClipData.newRawUri("附件", uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      mainHandler.post {
        try { ctx.startActivity(if (share) Intent.createChooser(intent, "保存或分享附件").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) else intent); promise.resolve(true) }
        catch (e: Exception) { promise.reject("ATTACHMENT_VIEW", "未找到可打开附件的应用，可尝试分享保存", e) }
      }
    } catch (e: Exception) { promise.reject("ATTACHMENT_ERR", e.message, e) }
  }

  @ReactMethod
  fun sha256Hex(msg: String, promise: Promise) {
    try {
      val md = MessageDigest.getInstance("SHA-256")
      val digest = md.digest(msg.toByteArray(Charsets.UTF_8))
      promise.resolve(digest.joinToString("") { "%02x".format(it) })
    } catch (e: Exception) {
      promise.reject("SHA256_ERR", e.message, e)
    }
  }

  @ReactMethod
  fun randomB64(len: Int, promise: Promise) {
    try {
      val n = len.coerceIn(16, 1024)
      val bytes = ByteArray(n)
      SecureRandom().nextBytes(bytes)
      promise.resolve(Base64.encodeToString(bytes, Base64.NO_WRAP))
    } catch (e: Exception) {
      promise.reject("RANDOM_ERR", e.message, e)
    }
  }

  @ReactMethod
  fun pbkdf2Hex(password: String, salt: String, iterations: Int, promise: Promise) {
    try {
      val iters = iterations.coerceIn(10_000, 1_000_000)
      val spec = PBEKeySpec(password.toCharArray(), salt.toByteArray(Charsets.UTF_8), iters, 256)
      val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
      val key = factory.generateSecret(spec).encoded
      promise.resolve(key.joinToString("") { "%02x".format(it) })
    } catch (e: Exception) {
      promise.reject("PBKDF2_ERR", e.message, e)
    }
  }

  @ReactMethod
  fun haptic(kind: String, promise: Promise) {
    try {
      mainHandler.post {
        try {
          val vm = if (Build.VERSION.SDK_INT >= 31) ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager else null
          val vibrator = vm?.defaultVibrator ?: ctx.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
          if (vibrator == null || !vibrator.hasVibrator()) {
            promise.resolve(false)
            return@post
          }
          val effect = when (kind) {
            "heavy" ->
              if (android.os.Build.VERSION.SDK_INT >= 29)
                VibrationEffect.createPredefined(VibrationEffect.EFFECT_HEAVY_CLICK)
              else VibrationEffect.createOneShot(30, VibrationEffect.DEFAULT_AMPLITUDE)
            "warn" ->
              if (android.os.Build.VERSION.SDK_INT >= 29)
                VibrationEffect.createPredefined(VibrationEffect.EFFECT_DOUBLE_CLICK)
              else VibrationEffect.createWaveform(longArrayOf(0, 25, 60, 25), -1)
            else ->
              if (android.os.Build.VERSION.SDK_INT >= 29)
                VibrationEffect.createPredefined(VibrationEffect.EFFECT_CLICK)
              else VibrationEffect.createOneShot(8, VibrationEffect.DEFAULT_AMPLITUDE)
          }
          vibrator.vibrate(effect)
          promise.resolve(true)
        } catch (e: Exception) {
          promise.reject("HAPTIC_ERR", e.message, e)
        }
      }
    } catch (e: Exception) {
      promise.reject("HAPTIC_ERR", e.message, e)
    }
  }
}
