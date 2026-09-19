# Orion for Roku TV 2.0

Native SceneGraph/BrightScript client for the complete Orion experience.

## Included

- Orion profile picker with PIN/password sign-in
- Server-enforced access rules for users and groups: assigned movies, TV
  episodes, music, music videos, collections, custom libraries, and ratings
- Every Orion media library, including custom libraries
- Movies, TV shows and episodes, music, music videos, collections and genre
  categories with paged browsing
- Orion IPTV and StreamForge live channels, both played through HLS
- Server themes, including new custom themes created in Orion after the Roku
  channel is installed
- Persistent server, signed-in profile and selected TV theme

## Sideloading

1. Enable **Developer mode** on the Roku, then reboot it.
2. Open `http://ROKU-IP` from a computer on the same LAN and sign in.
3. Upload the `Orion-Roku-2.0.0.zip` release package.
4. Launch Orion and press `*` to enter the Orion address, for example `http://192.168.0.244:3001`.
5. Select an Orion profile and enter that profile's PIN or password.

The Roku and Orion server must be on the same LAN. Roku consumes Orion's HLS output, so HEVC, MKV, incompatible audio and IPTV are converted by Orion into Roku-compatible H.264/AAC.

## Profile access controls

Use **Settings → Users → Assign Media** in Orion to give a profile or group
access to individual media, collections, and custom libraries. The Roku asks
the server for an already-filtered catalogue and the playback endpoints verify
the signed-in profile again, so restricted titles cannot be started merely by
typing a media URL on the Roku.

Administrators can optionally set live-channel allow-lists with
`mediaAccess.liveChannels` or `mediaAccess.iptvChannels`. If those lists are
not set, live television remains available to a restricted media profile.
