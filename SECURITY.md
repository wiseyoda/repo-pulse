# Security

repo-pulse runs a local HTTP server. Its threat model is a page you open yourself, on your
own machine, against a repository you already have read access to. It:

- binds `127.0.0.1` only and refuses requests whose `Host` is not loopback (DNS rebinding);
- refuses cross-origin `POST`s;
- serves diffs and file contents only for paths git itself reports as changed;
- never writes into the watched repository and runs git with optional locks disabled.

It is not designed to be exposed beyond your machine. Do not port-forward it.

## Reporting a vulnerability

Please do not open a public issue. Email **patterson423@gmail.com** with a description and,
if you can, steps to reproduce. You will get a reply within a few days. Fixes ship as a
regular release with credit to the reporter unless you would rather stay anonymous.
