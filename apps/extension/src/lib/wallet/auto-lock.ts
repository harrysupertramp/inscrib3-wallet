// Alarms survive MV3 service-worker suspension; setTimeout would not.

export const AUTO_LOCK_ALARM_NAME = 'arkade-auto-lock';
const AUTO_LOCK_MINUTES = 15;

export function scheduleAutoLock(): void {
  browser.alarms.create(AUTO_LOCK_ALARM_NAME, { delayInMinutes: AUTO_LOCK_MINUTES });
}

export function cancelAutoLock(): void {
  void browser.alarms.clear(AUTO_LOCK_ALARM_NAME);
}
