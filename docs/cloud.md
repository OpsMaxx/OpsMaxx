# Cloud servers

Google Cloud, AWS and Azure machines as ordinary OpsMaxx servers — reached through the
provider tooling you already have, signed in as you already are.

[← Back to the README](../README.md)

---

## What this is

A GCE instance behind IAP, an EC2 instance with no public address, an Azure VM that only
accepts Microsoft Entra ID logins: three machines with no address you can type and no
credential you hold. Cloud servers make those first-class entries in your connection list.

OpsMaxx **does not bundle, install or reimplement** `gcloud`, `aws` or `az`, and never offers
to install one. It finds the one you already have, tells you which file it found and what
version it is, and uses it. Your cloud identity stays where it belongs: if your organisation
uses IAM, SSO, Entra ID, MFA or conditional access, those apply because OpsMaxx never went
around them.

> Cloud identity belongs to the cloud provider. OpsMaxx orchestrates the connection.

## It brokers the connection — it does not wrap a command

This is the design decision everything else follows from, and it is worth being precise
about because a lot of tools in this space do the other thing.

OpsMaxx does not run `gcloud compute ssh` and paste its output into a terminal. The provider
CLI is used for five things — detection, sign-in state, read-only discovery, minting a
short-lived credential, and opening a tunnel — and then **OpsMaxx connects itself**, with the
same SSH engine every other server uses.

```
Add Server → provider
       │
       ├── detect the CLI, check you are signed in
       ├── discover projects / regions / instances
       ├── mint a short-lived credential
       └── open a tunnel, if the machine has no address
                │
                ▼
        an ordinary SSH connection
                │
   Terminal · SFTP · monitoring · Docker · Kubernetes · tunnels · databases
```

The practical difference is that a cloud server is not a terminal in a box. Because the
result is a real SSH session, **everything else in OpsMaxx works against it**: the file
browser, the metrics strip, container and Kubernetes views, port forwards, a database
tunnelled through it, and the MCP tools. A wrapper around the provider's own SSH command
would give you a terminal and nothing else.

It also removes a class of risk rather than defending against it. OpsMaxx never invokes
OpenSSH and never passes SSH arguments through, so there is no `ProxyCommand` to smuggle a
local command into — the field that would carry one does not exist.

## What you need

The provider's CLI installed and signed in. Nothing else, and nothing inside OpsMaxx.

```bash
gcloud auth login          # Google Cloud
aws configure  /  aws sso login   # AWS
az login                   # Azure
```

The connection editor shows what it found — the exact path, the version, and which account
you are signed in as — and says which of those is missing when something is wrong. A missing
CLI, a signed-out session and an expired session are three different problems with three
different fixes, and OpsMaxx names which one you have rather than reporting "connection
failed".

## Per provider

### Google Cloud

Pick a project, a zone and an instance. **Transport** is *Auto* by default, which tunnels
through IAP when the instance has no external address and connects directly when it has one;
you can force either.

OS Login issues the login. OpsMaxx generates a keypair for the connection, publishes the
public half with a **five-minute TTL**, and lets IAM decide whether you may log in and as
whom. Nothing is enrolled on your account permanently.

### AWS

Pick a profile, a region and an instance, and give the OS user to log in as (`ubuntu`,
`ec2-user`). **Transport** *Auto* uses an EC2 Instance Connect Endpoint when there is no
public address.

EC2 Instance Connect publishes a key the instance accepts for **sixty seconds**. That is the
entire credential: there is no `.pem` to distribute, rotate or lose, and a key left behind by
a crash has expired long before anyone could use it.

### Microsoft Azure

Pick a subscription, a resource group and a VM. Authentication is **Microsoft Entra ID**,
which issues a short-lived SSH certificate per connection. The certificate and its key live
in a temporary directory that is deleted when the connection ends.

Azure's other option — a local VM user with a key or password you already hold — is
deliberately not offered here. That is an ordinary SSH server, and the **SSH** connection
type already does it properly, with the vault behind it.

## Discovery

Each level is populated from your own CLI: projects/profiles/subscriptions, then
zones/regions/resource groups, then instances. Machines that are stopped are listed with
their state rather than hidden — a stopped instance is one you may well want to save a
connection for.

Every level is also **typeable**. Listing every project in an organisation needs a broader
grant than reaching one instance in it, so a failure to enumerate never becomes a failure to
connect: the list falls back to a text box and says why.

## What is stored, and what is not

A saved cloud server holds **identifiers only** — a project and instance name, a region and
instance id, a resource group and VM.

Never stored: access tokens, refresh tokens, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_SESSION_TOKEN`, Azure tokens, or any key or certificate. There is nothing to store —
credentials are minted per connection and expire on their own. Reconnecting tomorrow uses
whatever session your provider CLI has then, not one OpsMaxx captured today.

An encrypted backup carries a cloud server as a few strings. It carries no way to reach
anything, because there is nothing in it to reach with.

## Seeing what it runs

The connection editor has **What OpsMaxx will run**, which shows the actual commands — the
real ones, built by the same code that issues them, so the preview cannot drift from what
happens. It deliberately does *not* show a friendly `gcloud compute ssh` one-liner, because
OpsMaxx does not run one and printing it would be a plausible-looking lie in the one place
you go to find out what is really going on.

Which binary was used and what version it was is recorded in the debug log when debug
logging is on, along with the lifecycle of each connection. Provider output passes through
the same redaction layer as everything else before it is written anywhere.

## AI agents and cloud servers

Cloud servers are **fully addressable by AI agents**, like any other server and under the
same access groups and approval prompts. An agent can list them, connect, run commands, and
create or change cloud connection records.

That is a deliberate widening, and it is worth stating plainly: reaching a cloud machine
means running a program on *your* computer, so an agent can cause `gcloud`, `aws` or `az` to
start. Two things bound it, and both are enforced in code rather than by convention:

- **An agent chooses identifiers, never a command.** Nothing on this path accepts a command
  string. Every argument is an element of an argument array assembled by a builder, and no
  shell is involved at any point.
- **Every identifier is pattern-checked, and none may begin with `-`.** A value that looks
  like an option is refused before any process starts — checked in the form, again on an
  agent write, again when the record is read back from disk, and again in the builder.

If that trade is not one you want, deny the `manageServers` capability, or put cloud servers
in a workspace your agent sessions do not cover.

## Limits, stated

- **No jump hosts.** A cloud target is a local tunnel or an address the provider resolved,
  and neither can be carried by a bastion. Setting both is refused rather than ignored.
- **No VPN profile.** Same reason; the cloud target is the transport.
- **SSH only.** There is no remote-desktop path through any of this.
- **Azure is Entra ID only** — see above for why the local-user option is absent.
- **A crash can leave a tunnel running.** Quitting OpsMaxx tears down provider tunnels with
  the connections that own them. Being killed outright does not; a stray `start-iap-tunnel`
  or `open-tunnel` process may survive and can be ended from your process manager.

## Certificates

Azure's Entra ID login needs OpenSSH certificate authentication, which the SSH library
OpsMaxx uses does not implement. It is added by a patch carried in `patches/`, applied on
install, and covered by a test that authenticates against a real `sshd` — because an
unpatched build does not fail loudly, it fails as "Permission denied (publickey)", which
looks exactly like a permissions problem in Azure.
