/**
 * English strings of the "What's new" window (hud/news.ts, world/features/news.ts; docs/CHANGELOG_WINDOW.md). The
 * entries themselves come from the server (content/changelog). Spread into en.ts; en.ts keys win over a duplicate here.
 */
export const enNews = {
  'news.title': "What's new",
  'news.oneNew': 'A new update',
  'news.counterNew': '{n} of {count} new updates',
  'news.counter': 'Update {n} of {count}',
  'news.prev': 'Newer',
  'news.next': 'Older',
  'news.all': 'All updates',
  'news.allTitle': 'All updates',
  'news.allCount': '{count} updates',
  'news.back': 'Back',
  'news.close': 'Close',
  'news.gotIt': 'Got it',
  'news.new': 'New',
  'news.empty': 'No update notes yet.',
  'news.loadFailed': "The update notes could not be loaded. Try again in a moment.",
  'menu.news': "What's new",
  'keys.window.news': "What's new (update notes)",
} satisfies Record<string, string>
