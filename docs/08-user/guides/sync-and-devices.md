---
docgov:
  id: sync-and-devices
  type: user.guide
  authority: audience
  audience:
    - users
  visibility: public
  status: active
  generation:
    mode: human-maintained
---
# Sync & devices

Keep your servers, workspaces, tunnels and vault the same on every computer you use OpsMaxx on, through a relay you run yourself.

## Goal

You use OpsMaxx on more than one machine and want the same estate on each, without exporting and importing. Sync & devices carries your data between your own devices through a relay you run (the relay software is called addy). Everything is sealed on your device before it leaves, and the relay holds no key, so it stores your data without being able to read it.

**Where it is.** The **Sync** button on the left-hand rail (its tooltip says *Sync & devices*). On a new install it is on. On an install that was upgraded, turn it on in **Settings → Modules**. The same setup flow is also in **Settings → Security → Sync & devices**.

**What syncs.** Servers, workspaces, folders, tunnels, VPN profiles, saved databases, CI/CD connections, HTTP collections and environments, HTTP checks, monitor groups, your trusted SSH host keys, and which environment variables hold secrets.

**Credentials sync too, inside the vault.** Passwords, keys and tokens live in the vault, and the vault travels as it is stored on disk: encrypted with your master password. Nothing in sync opens it, and the recovery phrase cannot open it. On another device you unlock it with the same master password. The values of secret environment variables stay on each machine; only which variables hold secrets is carried.

**Joining with a machine that already has servers or a vault.** Nothing on it is thrown away. On the first sync, its lists (servers, workspaces, tunnels and the rest) are added to the account's, matched by their internal ids. If the account holds the same item with different details, both versions are kept and **Sync & devices** asks you which to use. The vault cannot be merged automatically, because it is encrypted with this machine's master password. If the account already has a vault, that one replaces this machine's, and this machine's is set aside, not deleted. **Sync & devices** then shows both: unlock the account's vault, type the master password this machine's vault was made with, and press **Add its entries to this vault**. Entries that are the same in both are skipped; one that differs is added as a second entry named "(other copy)".

**What does not sync.** Open tabs and panes, window layout, most settings, folder shares (they name folders on one computer), and files that another device sent to this one.

## Steps

### 1. Set up the first device

You need the relay's address and one **invite** from whoever runs the relay. If the relay is yours and serves its operator console, open `https://<relay>/admin`, sign in and create one. Only the first device ever needs an invite.

1. Open **Sync & devices**. Under **Which of these is this machine?**, choose **This is my first device**.
2. Fill in **Relay address**, **Invite**, and **What to call this device**. The name starts as this computer's hostname; change it if you call the machine something else. It is shown in the device list on every device, and it cannot be changed later.
3. Press **Create an account on this relay**.
4. **Write down the twelve-word recovery phrase.** It is shown once, and OpsMaxx keeps no copy. **Copy** puts it on this computer's clipboard, where anything that reads the clipboard can see it, including the clipboard shortcut, which would send it to your other devices; OpsMaxx takes it off the clipboard after a minute if nothing else has been copied since. Press **I have written them down**, then type back the three words it asks for, from what you wrote, not from the screen. **Done — I have them** stays disabled until they match. If you click away to another part of the app before finishing, the phrase is still there when you come back, until you quit OpsMaxx.

### 2. Pair another device

Both machines have to be open at the same time.

1. **On the machine you already use**, open **Sync & devices**, find **Add another device**, and press **Show a code on this device**. It shows a pairing code, a pairing link, and how long the code has left. A code stops working after three minutes, or as soon as you leave Sync & devices for another view. **Cancel** stops it. Never give the code or the link to anyone else: nobody, including whoever runs your relay, will ever ask for it.
2. **On the new machine**, either:
   - open the pairing link there. OpsMaxx opens **Sync & devices** with the relay address and the pairing code already filled in, or
   - open **Sync & devices**, choose **I already use OpsMaxx on another machine**, type the relay address (shown on the first machine under *Add another device*, with a copy button), press **Type a code from another device**, and paste the pairing code.
3. Press **Join** on the new machine. It shows how long it will wait, and a **Cancel** button.
4. **Compare the seven emoji on both screens.** The same emoji are also written out as words, so you can compare them over the phone. One press of **They match** on the machine that showed the code adds the other machine and gives it everything the account syncs, your servers, connections and vault, so press it only when the other screen shows the same emoji. If the other screen is still waiting, or shows different emoji, someone else used the code: press **They do not match** and start again. Press **They match** on the new machine too; it shows the relay it is joining, and waits, with a countdown and a **Cancel** button, until the other one has pressed it. If you do not know that relay, or the emoji differ, press **They do not match**: something is between the two devices, so try again on a network you trust.
5. On the machine that showed the code, give the new machine a name under **What is the other machine called?** before pressing **They match**. That name is permanent. Left empty, the device is listed by the start of its key.

A link never joins by itself. It only fills in the form; you still press **Join** and compare the emoji.

Any device on the account can add the next one. There is no main device.

### 3. Use it

- Sync runs on its own every five minutes. **Sync now** runs a pass straight away.
- **Files** sends a file to one of your other machines. It waits on the relay if that machine is asleep. Received files are listed, never opened for you, and are deleted after a week.
- **Send and receive the clipboard with a keystroke** is off until you turn it on. `Cmd/Ctrl+Shift+C` sends this clipboard to your other devices and `Cmd/Ctrl+Shift+V` takes the newest one sent here. These shortcuts are taken from every application while OpsMaxx runs.
- A clipboard or file is encrypted for the one device it is sent to and signed by the device that sent it. The receiving machine accepts it only from a device still on its device list, so a removed device can neither read nor send one. Both machines need OpsMaxx 0.59.1 or later.
- **Pause sync** stops carrying data without leaving the account. It lasts until OpsMaxx next opens.

### 4. When the same thing changed on two devices

If two machines changed the same thing before syncing with each other, OpsMaxx keeps both and asks. It is already using the version marked **In use now**; the other is set aside. The first sync on a newly paired machine that already had its own data is the common case: the account's copy is used and this machine's own copy is the one set aside.

- **Keep the version in use (delete the other copy)**, or **Replace it with the other copy**. Either way the copy you did not keep is deleted from the relay and cannot be brought back.
- **Keep both** appears when both versions are lists. It joins them, duplicates included, and shows the count first.
- **Decide later** (or `Esc`) writes nothing. The question comes back the next time OpsMaxx opens, or straight away from **Review now** on Sync & devices. New conflicts found by a later sync are offered as soon as they arrive.

The vault is encrypted, so its two versions cannot be shown side by side. Choose by when each was made and by which machine.

### 5. Recovery phrase

If every device on the account is gone, choose **My other devices are gone** on a new machine, enter the relay address, the twelve words (case and extra spaces do not matter) and a name for this device, and press **Recover this account**. No invite is needed. The screen that follows stays until you press **Done**.

When it finishes it tells you how many devices are on the account. Read that list: anyone who has seen your phrase could have added a device the same way. Remove any you do not recognise.

### 6. Remove a device, or leave

- **Remove** (on another device's row, then **Remove it**) takes that device off the account. Everything OpsMaxx stores on it is deleted the next time it opens and reaches the relay. A device kept offline never hears, and removing a device does not take back data it already has. For a lost or stolen machine, also use **Change the account key**: it needs your recovery phrase and re-seals everything under a new key.
- **Leave** (then **Leave the account**) on this device stops sync here and forgets the keys this device holds. Your servers, workspaces, tunnels and vault stay on this computer as they are. If your other devices still list this one afterwards, remove it from one of them. If this is the only device on the account, the recovery phrase is the only way back in.

## Verification

- **The account exists.** The **Account** tile reads *On* and names the relay, and **Where you are** ticks the first steps.
- **Two devices are on it.** The **Devices** table lists both. The characters under each name are the start of that device's key, and the same characters appear on the machine itself beside *This device*.
- **Data is moving.** The **Sync** tile reads *Live*, and **Last sync** shows a time. Add a server on one machine, press **Sync now** there and then on the other, and it appears.

### Common problems

| What you see | What it means and what to do |
|---|---|
| A banner at the top saying this device could not sign in | Sync is not running on this device. The banner gives the reason; press **Try again** once it is fixed. |
| *Sync last failed … could not carry your …* | One kind of data did not sync on the last pass. The rest of the sentence says why. The next pass tries again, or press **Sync now**. |
| *the other device did not answer in time* | The pairing code ran out, or the code was mistyped. Start a new code on the first machine and type that one. If the first machine already showed emoji and someone pressed **They match** there, another device may have used your code: check the device list on that machine and remove any device you do not recognise. |
| The showing machine says the pairing failed while the new one is still waiting | The code typed on the new machine was wrong. Press **Cancel** on the new machine, start a new code, and type it again. |
| *This device is not connected to the relay right now, so nothing was synced.* | **Sync now** could not reach the relay. Check the network, or the sign-in banner. |
| A link that does nothing but show a message | The link was refused, for example because its relay is not `https`. The message says why. |
| *That pairing link is for a machine joining an account* | The link was opened on a machine that is already on an account. Open it on the machine you are adding. |
| *… speaks a different addy protocol version than this copy of OpsMaxx* | OpsMaxx and the relay disagree on the protocol version. Update OpsMaxx; if it is already current, whoever runs the relay needs to update it. |
| *It was sent by an older version of OpsMaxx … Update OpsMaxx on the sending device.* | A clipboard or file came from a machine running OpsMaxx 0.59.0 or earlier, which cannot prove which device sent it, so it was not used. Update OpsMaxx on that machine and send it again. |
| *that file is … MB and the limit is … MB* | Files sent between your devices go through the relay, which takes about 6 MB in one request. Use a file-transfer tool for anything bigger. |

## Related

- [Mount a folder from this computer](mount-a-folder-from-this-computer.md), whose folder shares stay on one computer and do not sync
- [Design of record for the relay](../../plans/addy.md)
