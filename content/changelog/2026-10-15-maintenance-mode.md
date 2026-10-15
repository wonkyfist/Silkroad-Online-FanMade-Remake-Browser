---
id: 2026-10-15-maintenance-mode
date: 2026-10-15T02:00
title: October 15: maintenance mode
summary: Admins can now put the server into maintenance with a countdown. Everyone gets warned in time, is saved and sent to the login screen at zero, and can log back in as soon as maintenance ends.
---
## Maintenance mode

- **A warning first:** when maintenance is scheduled, everyone online sees a notice in the middle of the screen and in chat, with the reason and roughly how long it will take. A small countdown stays at the top of the screen, and reminders come at 30, 15, 10, 5, 3, 2 and 1 minutes, 30 seconds and 10 seconds.
- **At zero:** your character is saved exactly like a normal logout, and you're taken back to the login screen with a message saying when the server is expected back.
- **While it's on:** the server list shows **Maintenance** and logging in is paused. Admins and GMs stay in to do their work.
- **When it's over:** the server shows Online again, and you can log straight back in.
- For admins: a Maintenance card on the admin dashboard (start with a countdown, cancel, end), and `/maintenance start | cancel | end` in game. It survives server restarts, so updates can be deployed during maintenance.
