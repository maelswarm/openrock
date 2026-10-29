Certificates for the HTTPS tests only. Not used anywhere else. Open Rock has to accept every one of them.

- selfsigned-*: self-signed, issued for 127.0.0.1 / localhost
- othername-*: issued for gemma.invalid, so the name doesn't match the address the tests connect to
- expired-*: valid only during 2020
- weak-*: a 512-bit RSA key, too small to sign a TLS 1.3 handshake (works over TLS 1.2)
- ed25519-*: an Ed25519 key, which Bun's TLS library doesn't offer by default
- privateca-*: issued by a private CA that isn't sent with the certificate
