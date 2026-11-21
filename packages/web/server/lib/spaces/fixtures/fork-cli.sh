#!/bin/sh
[ "$1" = "--openchamber-info" ] || exit 2
printf '%s\n' '{"distribution":"openchamber","version":"2.3.2"}'
