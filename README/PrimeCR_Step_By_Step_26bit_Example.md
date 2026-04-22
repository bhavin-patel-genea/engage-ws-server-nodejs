# PrimeCR Generation: Step-by-Step Guide

> **Card Number:** 10984
> **Facility Code:** 55
> **Card Format:** H10301 (26-bit Wiegand Standard)
> **Site Key:** `00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff`

---

## What is PrimeCR?

PrimeCR (Primary Credential) is the **encrypted representation of a card** stored inside the Schlage lock's database. When someone swipes a card, the lock reads the raw bits, builds a PrimeCR the same way, and compares it against its stored database. If it matches, access is granted.

---

## The H10301 Format (26-bit Wiegand)

This is the most common card format used with HID proximity cards. It has 26 bits arranged in a fixed layout:

```
Bit Position:   0      1-8        9-24          25
Field:         [EP]  [FC: 8 bits] [Card: 16 bits] [OP]
```

| Field              | Bits                    | Purpose                             |
| ------------------ | ----------------------- | ----------------------------------- |
| EP (Even Parity)   | 1 bit (position 0)      | Error detection for the first half  |
| FC (Facility Code) | 8 bits (position 1-8)   | Identifies the building/site        |
| Card Number        | 16 bits (position 9-24) | Identifies the individual card      |
| OP (Odd Parity)    | 1 bit (position 25)     | Error detection for the second half |

**Why 26 bits?** The original Wiegand protocol was designed for simple, fast transmission between card and reader. 8-bit FC supports 256 facilities, 16-bit card supports 65,535 unique cards per facility. Two parity bits catch transmission errors.

---

## Step 1: Convert FC and Card Number to Binary

**Facility Code 55:**

```
55 / 2 = 27 remainder 1
27 / 2 = 13 remainder 1
13 / 2 =  6 remainder 1
 6 / 2 =  3 remainder 0
 3 / 2 =  1 remainder 1
 1 / 2 =  0 remainder 1
```

Read remainders bottom-to-top: `110111` => pad to 8 bits: **`00110111`**

**Card Number 10984:**

```
10984 / 2 = 5492 remainder 0
 5492 / 2 = 2746 remainder 0
 2746 / 2 = 1373 remainder 0
 1373 / 2 =  686 remainder 1
  686 / 2 =  343 remainder 0
  343 / 2 =  171 remainder 1
  171 / 2 =   85 remainder 1
   85 / 2 =   42 remainder 1
   42 / 2 =   21 remainder 0
   21 / 2 =   10 remainder 1
   10 / 2 =    5 remainder 0
    5 / 2 =    2 remainder 1
    2 / 2 =    1 remainder 0
    1 / 2 =    0 remainder 1
```

Read remainders bottom-to-top: `10101011101000` => pad to 16 bits: **`0010101011101000`**

**Why convert to binary?** The card physically transmits data as individual 1s and 0s over the Wiegand wire protocol. The lock works in binary at the bit level.

---

## Step 2: Place FC and Card into the 26-bit Layout

```
Position:  [0]   [1  2  3  4  5  6  7  8]   [9  10 11 12 13 14 15 16 17 18 19 20 21 22 23 24]   [25]
Field:      EP    ├──── FC (8 bits) ─────┤    ├──────────── Card (16 bits) ───────────────────┤    OP
Value:       ?    0  0  1  1  0  1  1  1      0  0  1  0  1  0  1  0  1  1  1  0  1  0  0  0      ?
```

Parity bits (position 0 and 25) are unknown (`?`) — we calculate them next.

**Why this order?** The Wiegand standard puts the parity bit first, then FC, then Card, then parity last. Every H10301 reader and lock expects this exact arrangement.

---

## Step 3: Calculate Even Parity (Bit 0)

Even parity covers the **first 13 bits** (positions 0 through 12). We look at bits 1-12 and set bit 0 so the total count of 1s is **even**.

Count the 1s in bits 1-12:

```
Bit 1:  0
Bit 2:  0
Bit 3:  1  <-- 1
Bit 4:  1  <-- 2
Bit 5:  0
Bit 6:  1  <-- 3
Bit 7:  1  <-- 4
Bit 8:  1  <-- 5
Bit 9:  0
Bit 10: 0
Bit 11: 1  <-- 6
Bit 12: 0
```

Count = **6** (already even). Set bit 0 = **0**.

**Why even parity?** If any single bit flips during transmission, the count becomes odd and the reader knows the data is corrupted. It's a simple error-detection mechanism.

---

## Step 4: Calculate Odd Parity (Bit 25)

Odd parity covers the **last 13 bits** (positions 13 through 25). We look at bits 13-24 and set bit 25 so the total count of 1s is **odd**.

```
Bit 13: 1  <-- 1
Bit 14: 0
Bit 15: 1  <-- 2
Bit 16: 0
Bit 17: 1  <-- 3
Bit 18: 1  <-- 4
Bit 19: 1  <-- 5
Bit 20: 0
Bit 21: 1  <-- 6
Bit 22: 0
Bit 23: 0
Bit 24: 0
```

Count = **6** (even). Set bit 25 = **1** to make total = 7 (odd).

**Why odd parity?** Same reason as even parity — error detection — but using the opposite rule for the second half so that an all-zeros card doesn't accidentally pass both checks.

---

## Step 5: Complete 26-bit Card Data

```
Bit:   0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25
       ─  ── ── ── ── ── ── ── ──  ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ── ──
Value: 0  0  0  1  1  0  1  1  1  0  0  1  0  1  0  1  0  1  1  1  0  1  0  0  0  1
       │  ├────── FC: 55 ───────┤  ├──────────── Card: 10984 ──────────────────────┤  │
       EP                                                                             OP
```

Full 26-bit string: **`00011011100101010111010001`**

---

## Step 6: Convert 26 Bits to Bytes

Computers and encryption work with **bytes** (groups of 8 bits), not individual bits. Our 26 bits don't divide evenly into bytes:

```
26 bits / 8 = 3 bytes + 2 bits remaining
```

We pad with **6 trailing zeros** to fill the last byte:

```
Byte 1:  00011011  = 0x1B
Byte 2:  10010101  = 0x95
Byte 3:  01110100  = 0x74
Byte 4:  01000000  = 0x40
         ^^
         Original 2 bits + 6 zeros padding
```

Result: **`1B 95 74 40`** (4 bytes)

**Why pad with trailing zeros?** The last byte has only 2 real bits of data. We fill the remaining 6 positions with zeros to complete the byte. This is a standard left-aligned bit-to-byte packing — the meaningful data stays at the most-significant (left) side.

---

## Step 7: Build Clear PrimeCR (16 Bytes)

AES-256 encryption operates on **exactly 16 bytes** (128 bits) at a time. Our card data is only 4 bytes. We must pad to 16 bytes.

**Start with a 16-byte buffer, every byte set to `0xFF`:**

```
FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF FF
```

**Copy our 4 card bytes into positions 0-3:**

```
1B 95 74 40 FF FF FF FF FF FF FF FF FF FF FF FF
├── card ──┤ ├─────── padding (stays FF) ───────┤
  4 bytes                 12 bytes
```

**Clear PrimeCR** = `1b957440ffffffffffffffffffffffff`

**Why `0xFF` and not `0x00` for padding?** This is Allegion's design choice. When a card is swiped, the lock does the **exact same thing**: reads the raw bits, packs into bytes, copies into a 16-byte buffer pre-filled with `0xFF`. Both sides (server and lock) must pad identically for the encrypted result to match. Allegion confirmed this pattern in their training materials — every working sample uses `0xFF` padding.

**Verification from Allegion's training card:**

```
Training card 802 (37-bit): clear PrimeCR = 815E310628FFFFFFFFFFFFFFFFFFFFFF
                                            ├─ 5 bytes ─┤├── 11 bytes of FF ──┤
```

---

## Step 8: Encrypt with Site Key (AES-256)

Now we encrypt the clear PrimeCR so it can be stored securely in the lock's database.

**Encryption parameters:**

| Parameter | Value                                   | Why                                             |
| --------- | --------------------------------------- | ----------------------------------------------- |
| Algorithm | AES-256-CBC                             | Allegion's specified encryption for PrimeCR     |
| Key       | `00112233...` (64 hex chars = 32 bytes) | The Site Key — must match the lock's key        |
| IV        | `00000000000000000000000000000000`      | All zeros (16 bytes). With one block, CBC = ECB |
| Input     | `1b957440ffffffffffffffffffffffff`      | Our clear PrimeCR from Step 7                   |
| Padding   | None                                    | Input is already exactly 16 bytes               |

**Result:**

```
Input  (clear):     1b957440ffffffffffffffffffffffff
Key    (site key):  00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff
Output (encrypted): c1eb091ea93845729de142a5140af321
```

**Encrypted PrimeCR** = `c1eb091ea93845729de142a5140af321`

**Why encrypt?** If someone reads the lock's database (e.g., via BLE), they only see encrypted blobs, not actual card data. Without the site key, they cannot determine which cards have access.

---

## Step 9: Use in Doorfile

The encrypted PrimeCR goes into the `primeCr` field of the doorfile JSON that gets pushed to the lock:

```json
{
  "db": {
    "usrRcrd": {
      "deleteAll": 1,
      "delete": [],
      "update": [],
      "add": [
        {
          "usrID": 1,
          "adaEn": 0,
          "fnctn": "norm",
          "crSch": 1,
          "actDtTm": "20000101000000",
          "expDtTm": "21350101000000",
          "primeCr": "c1eb091ea93845729de142a5140af321",
          "prCrTyp": "card",
          "scndCrTyp": "null"
        }
      ]
    },
    "schedules": [
      {
        "days": ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
        "strtHr": 0,
        "strtMn": 0,
        "lngth": 1440
      }
    ],
    "holidays": [],
    "autoUnlock": []
  },
  "dbDwnLdTm": "",
  "nxtDbVerTS": "0x0000018xxxxxxxxx"
}
```

---

## What Happens When the Card Is Swiped

The lock performs the **exact same steps in reverse**:

```
Step 1:  Card transmits 26 bits over Wiegand → lock receives raw bits
Step 2:  Lock packs bits into bytes → 1B 95 74 40
Step 3:  Lock copies into 16-byte buffer with 0xFF padding → 1b957440ffffffffffffffffffffffff
Step 4:  Lock encrypts with its site key → c1eb091ea93845729de142a5140af321
Step 5:  Lock searches its database for matching primeCr
Step 6:  FOUND → checks schedule, activation/expiry dates
Step 7:  All checks pass → ACCESS GRANTED (green LED, unlock)
```

If the site key on the server and lock don't match, Step 4 produces a different encrypted value, Step 5 finds no match, and access is **denied** — even though the card data is correct.

---

## Complete Summary

```
FC: 55                  →  00110111                     (8 bits)
Card: 10984             →  0010101011101000              (16 bits)
Even Parity             →  0                             (1 bit)
Odd Parity              →  1                             (1 bit)
                           ──────────────────────────────────────
Full 26 bits            →  00011011100101010111010001
                           ──────────────────────────────────────
Byte-aligned            →  00011011 10010101 01110100 01000000
                        →  1B 95 74 40                   (4 bytes)
                           ──────────────────────────────────────
Clear PrimeCR           →  1B 95 74 40 FF FF FF FF FF FF FF FF FF FF FF FF
(16 bytes, FF padded)   →  1b957440ffffffffffffffffffffffff
                           ──────────────────────────────────────
AES-256 Encrypt         →  c1eb091ea93845729de142a5140af321
(with site key)            ──────────────────────────────────────
Doorfile primeCr field  →  "c1eb091ea93845729de142a5140af321"
```
