# Deployment target. Sourced by deploy.sh and gm.sh.
# Every value can be overridden by an environment variable of the same name, or in deploy/config.local.sh
# (gitignored). config.local.sh is sourced AFTER this file, so write plain assignments there, e.g.
#   DEPLOY_HOST=100.x.y.z        # your server's private/Tailscale IP
#   DEPLOY_USER=youruser         # the SSH user on the server
#   DEPLOY_BIND=$DEPLOY_HOST     # set it again: its default below was computed from the placeholder
# The YOUR_* values below are placeholders: deploy.sh and gm.sh refuse to run until they are replaced.

: "${DEPLOY_HOST:=YOUR_SERVER_PRIVATE_IP}"  # your server's private IP, e.g. its Tailscale IP (tailscale ip -4 on the server)
: "${DEPLOY_USER:=YOUR_SSH_USER}"           # the SSH login user on the server
: "${DEPLOY_KEY:=$HOME/.ssh/sro_deploy}"  # private key authorised in the server's ~/.ssh/authorized_keys
: "${DEPLOY_BIND:=$DEPLOY_HOST}"          # server HOST: the Tailscale address, so only the tailnet can reach it
: "${DEPLOY_PORT:=7000}"
: "${DEPLOY_KEEP_RELEASES:=3}"            # code releases kept on the server for rollback
# World export the server plays (WORLD_EXPORT in silkroad.env; docs/DEPLOY.md "Playing on the fields"): the streamed
# fields around Jangan. Written only once ~/silkroad-assets/out/world/<name>/ exists on the server; 'jangan' = the
# 3 x 3 town map. silkroad.local.env still overrides it.
: "${DEPLOY_WORLD_EXPORT:=jangan-fields}"

# Converted asset trees synced from work/<tree> to ~/silkroad-assets/<tree> on the server.
#   out      served at /out/ (OUT_DIR): what the game and server read today
#   out-opt  the slimmed copy (OUT_OPT_DIR, docs/ASSETS.md) for the loaders that switch to it
: "${DEPLOY_ASSET_TREES:=out out-opt}"
# What is not sent (deploy/assets.ts): a bare name is a top-level folder of every tree; <tree>:<path> is a folder or
# file of one tree, where * matches within a path segment and ** across segments.
#   debug, test, blender-ref     converter debug output, read by nothing at runtime
#   out:pbr                      the texture pipeline's working copy of the map sets (TX-R: the game reads the sets
#                                under its world root, /out-opt/pbr/, which optimize-out copies from here)
#   out-opt:pbr/**/*.ktx2        the KTX2 masters (~550 MB, docs/DEPLOY.md "Remastered textures"): shipped only once
#   out-opt:_decoders/ktx2       Ultra is wanted, together with their transcoder; without it Ultra takes the WebP 2048
#                                tier, so the two go (or stay) together
#   out:remaster/staging*, out:remaster/manifest.before-*
#                                the Meshy review staging (staging.json + staging/) and an old manifest backup; the rest
#                                of out/remaster/ ships (manifest.json + sets/, ~31 MB: the user's picks of 2026-09-29)
#   out-opt:remaster             optimize-out's copy of out/remaster/, never read (the game reads /out/remaster/ first)
#   out:world/*-edit, out-opt:world/*-edit
#                                the World Editor's staging exports (convert-region's <world>-edit), never served
#   out:trees, out-opt:trees     the tree tool's work products (sheets, sprite masters, B0 tiers, LOD drafts; ~400 MB):
#                                the game reads the 35 species from world/<name>/models/trees, which ships (wave 12, I-12)
: "${DEPLOY_ASSET_EXCLUDE:=debug,test,blender-ref,out:pbr,out-opt:pbr/**/*.ktx2,out-opt:_decoders/ktx2,out:remaster/staging*,out:remaster/manifest.before-*,out-opt:remaster,out:world/*-edit,out-opt:world/*-edit,out:trees,out-opt:trees}"
