# Optional verified build inputs

The Dockerfile downloads pinned upstream artifacts by default. An environment
with restricted access to an upstream release host may place the exact files
named by the Dockerfile in this directory. Every archive is still checked
against its pinned SHA-256 before extraction.

Large archives in this directory are deployment inputs and should not be
committed to source control.
