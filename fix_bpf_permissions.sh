#!/bin/bash

# Fix BPF permissions on macOS to allow non-root packet capture
# This changes ownership to root:admin and allows the admin group to read/write

echo "Fixing BPF permissions..."

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script with sudo:"
  echo "sudo $0"
  exit 1
fi

# Change group to admin and set permissions
chown root:admin /dev/bpf*
chmod 660 /dev/bpf*

echo "BPF permissions fixed."
ls -l /dev/bpf* | head -n 5
