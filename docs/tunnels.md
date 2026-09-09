# Tunnels and VPN

Port forwards, SOCKS proxies, WireGuard, OpenVPN and frp reverse proxies.

[← Back to the README](../README.md)

---

## SSH tunnels


Create local forwards, remote forwards or a SOCKS5 proxy over any saved server. Live connection counts are shown per tunnel, and a dropped SSH connection tears the listener down rather than leaving it accepting traffic that goes nowhere.

## VPN and reverse-proxy tunnels


OpsMaxx speaks **WireGuard**, **OpenVPN** and **frp**. Full guide: **[docs/VPN.md](VPN.md)**.

The default is the unusual part: **WireGuard runs entirely in userspace and needs no administrator rights.** There is no network interface, your routing table and DNS are untouched, and if OpsMaxx is killed there is nothing to clean up. The tunnel appears instead as local listeners — a SOCKS5 proxy on `127.0.0.1`, and any forwards you define — and you point individual connections at it.

That trade is deliberate. Reaching one bastion, one database or one internal service does not need your whole machine on the far network. When it genuinely does, system mode is one toggle away on Linux and Windows and asks for elevation each time you connect — with two stated limits: a full tunnel (`0.0.0.0/0`) is refused, and macOS is blocked for want of an Apple Developer ID. [docs/VPN.md](VPN.md) explains both. Neither affects the default.

- **Handshake age, not just a green dot.** A WireGuard tunnel whose process is up but whose handshake has gone stale is shown as **degraded** in amber, not connected in green. Up-but-not-passing-traffic and down are different problems, and almost no client distinguishes them.
- **SSH and databases over a VPN.** Pick a profile on a server or a database and it is started, waited for, and torn down with the session. If it cannot come up you see *the VPN's* error, not a connect timeout twenty seconds later.
- **Imported configs are treated as hostile.** A `.ovpn` file can run programs — `up`, `plugin`, `script-security` and friends execute before the server is ever contacted. OpsMaxx never hands your file to OpenVPN: it parses it, rejects anything that runs a program (quoting the line back to you), and generates a fresh config from what is left. `PostUp`/`PostDown` in a WireGuard `.conf` are refused the same way.
- **Split tunnelling by default.** `redirect-gateway` is off unless you turn it on, even when the profile asks for it. Downloading a profile should not silently reroute your machine.
- **frp states what it exposes, in words.** Each proxy carries a confirmation reading *"Make 127.0.0.1:5432 reachable from frp.example.com."* and the profile will not start until every one is ticked.
- **An AI agent can never start an frp profile**, and starting any VPN always asks for approval — even for an access group that allows it.

**Every tunnel engine is bundled, and one of them is not open source.** WireGuard (via the MIT `wireguard-go`), frp (Apache-2.0) and OpenVPN (GPL-2.0, macOS and Linux) are all built from pinned upstream source at release time — nothing to install, and each binary hash-verified before it runs. OpenVPN needs an adapter driver on Windows that cannot be shipped as a file, so a Windows OpenVPN profile still uses an OpenVPN you installed. Windows also ships `wintun.dll`, which is **proprietary** — the single component in OpsMaxx that is not open source, needed only by WireGuard system mode. Bundling GPL software obliges this project to publish the matching source, and every release carries OpenVPN's as an asset. All of it is set out in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

**There is no kill switch.** OpsMaxx tears down what it started when a tunnel drops, and says so — it does not install firewall rules, and does not claim to.

---

[← Back to the README](../README.md)
