# Orion for Roku TV

Native SceneGraph/BrightScript player for a local Orion server.

## Included

- Movies, TV shows and episode browsing
- Music and music videos
- Orion IPTV, paged for large provider lists
- StreamForge Channels with native HLS playback
- Orion color themes on the TV
- Persistent server address and theme selection

## Sideloading

1. Enable **Developer mode** on the Roku, then reboot it.
2. Open `http://ROKU-IP` from a computer on the same LAN and sign in.
3. Upload the `Orion-Roku-1.0.0.zip` release package.
4. Launch Orion and press `*` to enter the Orion address, for example `http://192.168.0.144:3001`.

The Roku and Orion server must be on the same LAN. Roku consumes Orion's HLS output, so HEVC, MKV, incompatible audio and IPTV are converted by Orion into Roku-compatible H.264/AAC.
