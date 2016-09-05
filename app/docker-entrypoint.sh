#!/bin/bash
set -e

[[ ! -f /var/log/nginx/error ]] && rm -f /var/log/nginx/*

exec "$@"
