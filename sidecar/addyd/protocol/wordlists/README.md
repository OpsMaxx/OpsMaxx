# The EFF long wordlist, vendored

7,776 words, in upstream order, one per line.

Source: <https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt>
Retrieved: 2026-09-17
SHA-256 of the original file: `addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e`

The upstream file is tab-separated `<dice roll>\t<word>`. The dice numbers are
an artifact of rolling five dice to pick a passphrase word; addy indexes by
POSITION, so only the words are kept. Position is what matters and position is
what must never change: entries are the protocol, so this file is never
reordered and never has anything removed from it.

## What it is for

The roster head hash, rendered as five words a human can actually compare.

Hex is not compared by people. They check the first four characters and the last
four, which is most of the way to not checking at all -- and this is the check
the entire anti-fork control rests on, performed between two OpsMaxx windows by
somebody who is probably worried. Five words from 7,776 is about 64 bits, which
is ample for a comparison, and they can be read down a phone.

The derivation is ours. Bitwarden documents that its fingerprint phrase is five
EFF words and deliberately does not publish the function that selects them, so
there is nothing to copy and no reason to try.

## Shared with the TypeScript client

Same discipline as the device-name lists: one file, both implementations read
it, and a test pins them identical. A phrase that differs between the two
windows being compared is worse than no phrase at all.

## Licence

The EFF wordlists are published under CC-BY-3.0 US by the Electronic Frontier
Foundation. Attribution is this file.
