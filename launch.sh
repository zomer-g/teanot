#!/bin/sh
# xhostd boot step: full env available. server.js runs migrations, then listens.
set -eu
exec node server.js
