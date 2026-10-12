package com.linktomobile

import android.content.Context
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
          val vm = ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager
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