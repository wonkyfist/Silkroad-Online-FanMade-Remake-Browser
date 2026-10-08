Retired remaster folders (2026-09-29, release build). Nothing reads them; kept instead of deleted.

- out-remaster-tests/<part>/multiview/*.webp: the 6 old Meshy test parts' WebP sets that sat under work/out/remaster/
  (not in the live manifest since manifest.before-cleanup.json). Their sources: work/remaster/meshy/<part>/.
- out-opt-remaster/: the stale work/out-opt/remaster/ copy (the old test manifest and the same 6 parts). The game reads
  /out/remaster/manifest.json first; optimize-out copies work/out/remaster/ into out-opt again when it runs, and the
  deploy keeps out-opt:remaster excluded.

Safe to remove this folder once nobody wants the old test sets.
