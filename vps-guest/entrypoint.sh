set -eu
case "${VPS_LIFETIME_SECONDS:-}" in ''|*[!0-9]*) exit 2 ;; esac
case "${VPS_SSH_PUBLIC_KEY:-}" in 'ssh-ed25519 '*) ;; *) exit 2 ;; esac
umask 077
printf '%s\n' "$VPS_SSH_PUBLIC_KEY" > /root/.ssh/authorized_keys
unset VPS_SSH_PUBLIC_KEY
ssh-keygen -A
exec timeout --foreground "$VPS_LIFETIME_SECONDS" /usr/sbin/sshd -D -e \
  -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PermitRootLogin=prohibit-password
