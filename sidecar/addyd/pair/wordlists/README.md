# The pairing-code wordlist

`codewords.txt` is **exactly 256 entries**, and the count is load-bearing rather
than tidy. A power of two means an index maps to bits exactly, the entropy claim
is arithmetic rather than an estimate, and drawing a word needs no rejection
sampling that could skew the distribution.

A pairing code is `NN-word-word`: 100 x 256 x 256 = 6,553,600 possibilities,
which is 22.6 bits. That number is the reason SPAKE2 is used rather than a
token typed into a box. Twenty-two bits is brute-forceable by anything that can
try repeatedly, and the whole point of a PAKE is that it cannot: a wrong guess
costs an attempt, and attempts are counted by the initiating device rather than
by the relay carrying the messages.

**The number comes first**, and that is deliberate. A device is named
`quiet-otter-41` and a pairing code is `42-inkwell-flatfoot` — the same three
pieces in a different order, so a user who types their device name into the
pairing box is told they typed a device name, rather than being told their code
is wrong.

Words are seeded from the device-name lists, which were already chosen to be
concrete, common, unambiguous when spoken and innocuous. This list evolves
independently of those: entries are appended, never reordered and never removed,
because the index is what a past code was drawn from.
