# BOBOCloud server for Linux

Run `./bobocloud-server` from the directory containing `config.json`. The file
in this archive is generated from the server's built-in defaults; it contains
no deployment credentials. Review the configuration and deployment guidance
for your environment before exposing the service to a network.

The binary-only archive contains just the executable. When started in a
directory without `config.json`, the server writes its built-in defaults there.
The server requires its configured runtime dependencies (including Docker for
container-backed compilation); the archive does not include Docker images.

Deployment guidance: https://github.com/NemophilistJohn/BOBOcloud-A-cloud-based-remote-compilation-platform/tree/main/server/deploy
