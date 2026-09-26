# Tunnels and VPN

Port forwards, SOCKS proxies, WireGuard, OpenVPN, frp reverse proxies and the traffic inspector.

[← Back to the README](../README.md)

---

## SSH tunnels


Create local forwards, remote forwards or a SOCKS5 proxy over any saved server. Live connection counts are shown per tunnel, and a dropped SSH connection tears the listener down rather than leaving it accepting traffic that goes nowhere.

## VPN and reverse-proxy tunnels


OpsMaxx speaks **WireGuard**, **OpenVPN** and **frp**. Full guide: **[docs/VPN.md](VPN.md)**.

The default is the unusual part: **WireGuard runs entirely in userspace and needs no administrator rights.** There is no network interface, your routing table and DNS are untouched, and if OpsMaxx is killed there is nothing to clean up. The tunnel appears instead as local listeners — a SOCKS5 proxy on `127.0.0.1`, and any forwards you define — and you point individual connections at it.

That trade is deliberate. Reaching one bastion, one database or one internal service does not need your whole machine on the far network. When it genuinely does, system mode is one toggle away on Linux and Windows and asks for elevation each time you connect — with three stated limits: a full tunnel (`0.0.0.0/0`) is refused, a prefix another interface already routes is refused rather than fought over, and macOS is blocked for want of an Apple Developer ID. [docs/VPN.md](VPN.md) explains all three. None of them affects the default.

- **Handshake age, not just a green dot.** A WireGuard tunnel whose process is up but whose handshake has gone stale is shown as **degraded** in amber, not connected in green. Up-but-not-passing-traffic and down are different problems, and almost no client distinguishes them.
- **SSH and databases over a VPN.** Pick a profile on a server or a database and it is started, waited for, and torn down with the session. If it cannot come up you see *the VPN's* error, not a connect timeout twenty seconds later.
- **Imported configs are treated as hostile.** A `.ovpn` file can run programs — `up`, `plugin`, `script-security` and friends execute before the server is ever contacted. OpsMaxx never hands your file to OpenVPN: it parses it, rejects anything that runs a program (quoting the line back to you), and generates a fresh config from what is left. `PostUp`/`PostDown` in a WireGuard `.conf` are refused the same way.
- **Split tunnelling by default.** `redirect-gateway` is off unless you turn it on, even when the profile asks for it. Downloading a profile should not silently reroute your machine.
- **frp states what it exposes, in words.** Each proxy carries a confirmation reading *"Make 127.0.0.1:5432 reachable from frp.example.com."* and the profile will not start until every one is ticked.
- **No access group lets an AI agent start an frp profile** — only a session you have put on the Bypass profile can — and starting any VPN asks for approval on the Auto and Ask first profiles, and on a Custom access group unless its Confirm risky actions switch is off (Full Access ships with it off). See [AI-MCP.md](AI-MCP.md#permission-profiles).

**Every tunnel engine is bundled, and one of them is not open source.** WireGuard (via the MIT `wireguard-go`), frp (Apache-2.0) and OpenVPN (GPL-2.0, macOS and Linux) are all built from pinned upstream source at release time — nothing to install, and each binary hash-verified before it runs. OpenVPN needs an adapter driver on Windows that cannot be shipped as a file, so a Windows OpenVPN profile still uses an OpenVPN you installed. Windows also ships `wintun.dll`, which is **proprietary** — the single component in OpsMaxx that is not open source, needed only by WireGuard system mode. Bundling GPL software obliges this project to publish the matching source, and every release carries OpenVPN's as an asset. All of it is set out in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).

**There is no kill switch.** OpsMaxx tears down what it started when a tunnel drops, and says so — it does not install firewall rules, and does not claim to.

## Traffic inspector

The fourth tab of this view is a **traffic inspector**: a Burp- or Fiddler-style proxy that shows the HTTP and HTTPS a machine is actually making, with terminals and SSH sessions routed through it automatically and a host that pins its certificate named rather than silently missing.

Reading HTTPS means terminating it, and terminating it means holding a certificate authority this machine trusts — which is the most dangerous key OpsMaxx handles, because whoever has it can impersonate any website to this computer. Nothing is installed at first run; trusting the authority is one explicit action behind one administrator prompt, with a matching removal for every store OpsMaxx can write to and the certificate's SHA-256 fingerprint shown in the panel so you can confirm your machine trusts the one the running proxy signs with. A listener on anything other than `127.0.0.1` is refused without credentials rather than warned about, because that is an open proxy for the network that also decrypts TLS. [SECURITY.md](../SECURITY.md#the-traffic-inspectors-certificate-authority) sets out how the key is generated, sealed and constrained.

---

[← Back to the README](../README.md)
