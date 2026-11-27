FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server \
  && rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_* \
  && mkdir -p /run/sshd /root/.ssh \
  && chmod 700 /root/.ssh
COPY entrypoint.sh /usr/local/bin/vps-entrypoint
ENTRYPOINT ["/bin/sh", "/usr/local/bin/vps-entrypoint"]
