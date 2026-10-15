/**
 * English strings of maintenance mode (docs/ADMIN.md §8): the countdown banner (ui/maintenance-banner.ts), the login
 * screen's message after the kick, the server list. The announcements themselves are the server's text. Spread into
 * en.ts; en.ts keys win over a duplicate here.
 */
export const enMaintenance = {
  'maint.banner.countdown': 'Server maintenance in {time}',
  'maint.banner.reason': '{reason}',
  'maint.banner.back': 'expected downtime about {min} min',
  'maint.banner.backHours': 'expected downtime about {hours} h',
  'maint.banner.on': 'Maintenance mode is ON (staff only)',
  'maint.banner.now': 'Server maintenance is starting…',
  'maint.title': 'Server maintenance',
  'net.maintenance': 'The server is under maintenance. Please try again later.',
  'error.maintenance': 'The server is under maintenance. Please try again later.',
} satisfies Record<string, string>
