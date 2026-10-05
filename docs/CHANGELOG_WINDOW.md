# The "What's new" window

Players never download anything, so updates arrive silently. The "What's new" window tells them what changed: the
update notes, with pictures, open once after they enter the world at their **next login** after an update. The Esc
menu's **What's new** entry (and the **J** key) reopens it with the full history.

Code: `packages/shared/src/news.ts` (entry files, the Markdown dialect, the safe renderer, the unseen rule),
`apps/server/src/news.ts` (loader), `apps/server/src/admin/news.ts` (admin routes), `apps/game/src/hud/news.ts` (the
window), `apps/game/src/world/features/news.ts` (when it opens), `apps/admin/src/pages/news.ts` (the News page). Wire:
docs/PROTOCOL.md "What's new". Tests: `packages/shared/test/news.test.ts`, `apps/server/test/news.test.ts`.

## 1. Writing an entry (at every deploy)

One file per update in **`content/changelog/<yyyy-mm-dd>-<slug>.md`**, images in **`content/changelog/img/`**.

```markdown
---
id: 2026-10-12-siege-of-jangan
date: 2026-10-12T18:00
title: October 12: The Siege of Jangan
summary: One or two sentences: the lead of the window and the line in the history list.
hero: oct12-siege.jpg
---
## A heading

A paragraph with **bold** and *italic* text.

- a list item
- another one, which can
  continue on an indented line

![Alt text](img/oct12-walls.jpg "The caption under the picture.")

![Before](img/oct12-before.jpg "Before")
![After](img/oct12-after.jpg "After")

> A highlighted note.
```

- **id** = the file name without `.md`: lower-case letters, digits and dashes (`NEWS_ID`). Start it with the date.
- **date**: `yyyy-mm-dd`, or `yyyy-mm-ddThh:mm` (UTC) when two entries share a day. Entries are ordered by date, then
  id, newest first. The window shows "October 12, 2026".
- **title** (at most 120 characters; a colon is fine), **summary** (at most 400), **hero** (optional image shown above
  the text), **draft: true** (optional; hidden from players).
- **Markdown**: `#`/`##`/`###` headings, paragraphs, `-` and `1.` lists, `**bold**`, `*italic*`, `` `code` ``, `>`
  notes, `---` rules, and `![alt](img/file.jpg "caption")` **on a line of its own**. Image lines with no blank line
  between them sit side by side (they wrap on small screens). There is **no HTML**: everything is shown as text.
  Links keep only their text.
- **Images**: web JPG, **at most 1280 px wide and under ~250 KB each** (`NEWS_IMAGE_MAX_BYTES` hard limit: 400 KB);
  keep an entry's total small (a few hundred KB to ~1 MB). Lower-case names only (`NEWS_IMAGE_NAME`); prefix them with
  the update (`oct12-...`). Convert with sharp, which the repo already has:

  ```sh
  node -e "const s=require(require.resolve('sharp',{paths:['packages/convert']}));s('in.png').resize({width:1280,withoutEnlargement:true}).jpeg({quality:80,mozjpeg:true}).toFile('content/changelog/img/oct12-x.jpg')"
  ```

- **Write for players**: friendly and concrete; what changed and why it matters to them. No commit hashes, server
  addresses, IPs, internal names, migrations or file paths.
- `pnpm vitest run packages/shared/test/news.test.ts` checks every repo entry: the front matter, that every image
  it names exists, and the image sizes.

## 2. The deploy step

1. Write `content/changelog/<date>-<slug>.md` and its images (§1); run the news test.
2. Commit them with the update. `pnpm deploy` ships the committed tree (`git archive HEAD`), so the server reads the
   new entry when it restarts.
3. Nothing else: every account that has not seen the entry gets the window at its next login. Players online during
   the deploy see it the next time they log in (a reconnect does not count).

To fix a typo on the live server without a deploy, use the admin panel (§4); fold the fix back into the repo file at
the next deploy and revert the panel copy.

## 3. In the game

- **When.** `welcome.news` says how many entries the account has not seen. After entering the world, the client
  fetches `GET /api/news` and, once the world has loaded (1.5 s later), opens the window on the unseen entries (at
  most 5, newest first) **once per login**: never on the login, server, character select or creation screens, not
  again after a reconnect or a trip through character select.
- **The window** (classic mframe window, sized to fit small screens): the date (and a "New" tag), title, summary,
  hero picture and the text in a scroll area with the retail scroll bar; pictures fit the width and a click shows one
  enlarged over the whole screen (a click or Esc closes it). Header: "1 of 3 new updates" with Newer / Older arrows.
  Footer: **All updates** (a list of every entry; a row opens it), **Close** (shows it again at the next login) and
  **Got it** (`POST /api/news/seen` with the newest entry: everything shown counts as seen, per account on the server,
  so it does not show again on another PC).
- **Reopening.** Esc → **What's new**, or **J**: every entry, newest first, unseen ones tagged "New" (no Got it).
- Strings: `apps/game/src/i18n/en-news.ts`. The mock (no server) has no news.

## 4. The admin panel (Live → What's new)

The list shows every entry (drafts too) and where it comes from: **repo**, **panel** (only in the panel) or **edited in
panel** (a panel copy over a repo file). The editor has the fields of §1, a Markdown text box, the image store
(Upload resizes in the browser to at most 1280 px wide JPEG, aiming under 250 KB; Insert / Hero buttons per image) and
a live preview drawn by the same renderer as the game.

- A save writes the panel copy `DATA_DIR/content/changelog/<id>.md` (atomic write), which wins over the repo file of
  the same id; uploads go to `DATA_DIR/content/changelog/img/`. Both survive deploys.
- **Revert** removes the panel copy (a repo entry comes back; a panel-only entry is deleted).

| Route | Body / answer |
|---|---|
| `GET /api/admin/news` | `AdminNewsView {entries (with source), images, problems}` |
| `GET /api/admin/news/<id>` | `AdminNewsRow` |
| `PUT /api/admin/news/<id>` | `AdminNewsPut {date, title, summary, hero?, draft?, body}` (≤ 96 KB): 400 with `issues` when it does not check (every image must exist) |
| `DELETE /api/admin/news/<id>` | `{reverted, entry}` (the repo entry, or null); 404 without a panel copy |
| `POST /api/admin/news-images` | `AdminNewsImageUpload {name, data (base64)}` (≤ 600 KB): 201 `{name, bytes, images}`; the bytes must be the type the name says (JPEG/PNG/WebP signature) |

Admin sessions only (game sessions get 401, non-admins cannot log in), like every `/api/admin` route; every write
adds an `admin_audit` row (`news.put`, `news.delete`, `news.image`).

## 5. Safety

- The renderer (`newsHtml`) escapes every piece of text and every attribute; raw HTML in an entry is shown as text.
  Links never become anchors. An image is drawn only when its source names a file of the image store
  (`img/x.jpg`, `x.jpg` or `/api/news/img/x.jpg`); other sources (URLs, `..`, `javascript:`, `data:`) are dropped,
  and the server refuses to save an entry that names one.
- Title and summary are cleaned of control and bidi characters. The image route serves only `NEWS_IMAGE_NAME` files
  from the two image folders (no traversal); uploads are checked against their signature.
