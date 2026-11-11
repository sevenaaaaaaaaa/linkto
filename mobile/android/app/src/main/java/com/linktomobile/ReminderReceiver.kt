package com.linktomobile

import android.app.*
import android.content.*
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/** System-owned local alarms; no mail credentials or note bodies leave app storage. */
class ReminderReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != "com.linkto.REMIND") { restore(context); return }
    val id = intent.getStringExtra("workItemId") ?: return
    val prefs = context.getSharedPreferences("linkto.reminders", Context.MODE_PRIVATE)
    if (!prefs.contains(id)) return
    prefs.edit().remove(id).apply()
    channel(context)
    val launch = Intent(context, MainActivity::class.java).apply {
      putExtra("workItemId", id); data = Uri.parse("linkto://reminder/" + Uri.encode(id))
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
    }
    val pending = PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val notification = NotificationCompat.Builder(context, "linkto-tasks")
      .setSmallIcon(android.R.drawable.ic_popup_reminder).setContentTitle("有一件待办到时间了")
      .setContentText("打开 LinkTo 查看今日安排").setContentIntent(pending).setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_HIGH).build()
    try { NotificationManagerCompat.from(context).notify(id, 1, notification) } catch (_: SecurityException) { /* Permission may be revoked after scheduling. */ }
  }
  companion object {
    fun channel(context: Context) {
      if (Build.VERSION.SDK_INT >= 26) (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
        .createNotificationChannel(NotificationChannel("linkto-tasks", "待办提醒", NotificationManager.IMPORTANCE_HIGH))
    }
    fun pending(context: Context, id: String): PendingIntent = PendingIntent.getBroadcast(context, 0,
      Intent(context, ReminderReceiver::class.java).apply { action = "com.linkto.REMIND"; data = Uri.parse("linkto://reminder/" + Uri.encode(id)); putExtra("workItemId", id) }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    fun schedule(context: Context, id: String, at: Long) {
      val alarm = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val operation = pending(context, id)
      if (Build.VERSION.SDK_INT < 31 || alarm.canScheduleExactAlarms()) alarm.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation)
      else alarm.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation)
    }
    fun restore(context: Context) {
      val prefs = context.getSharedPreferences("linkto.reminders", Context.MODE_PRIVATE)
      for ((id, value) in prefs.all) if (value is Long) {
        if (value > System.currentTimeMillis()) schedule(context, id, value) else prefs.edit().remove(id).apply()
      }
    }
  }
}
