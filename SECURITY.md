# Security policy

## Reporting a vulnerability

Open a **private security advisory** on this repository, or email the maintainers.

Please do not open a public issue for anything that would let someone read another person's
vault. Include the version, the platform, and a minimal reproduction. There is no bounty;
there is a fast acknowledgement.

## Scope

In scope: anything that discloses credentials to the wrong site or the wrong process,
weakens encryption at rest or in transit, breaks the content-script/extension trust
boundary, or lets a page reach the privileged API.

Out of scope: malware already running as the user, a compromised browser build, and a user
choosing a weak passphrase. These are stated explicitly, with reasoning, in
[docs/SECURITY.md](docs/SECURITY.md#not-defended).

## Supported versions

Alpha. Only the latest release is supported.

## Design and threat model

The full threat model, key hierarchy, storage map and cryptographic inventory are in
[docs/SECURITY.md](docs/SECURITY.md).
