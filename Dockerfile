FROM nginx:1.11.3
MAINTAINER Olivier ORABONA oorabona@agefos-pme.com

# Install wget and install/updates certificates
RUN apt-get update \
 && apt-get install -y -q --no-install-recommends \
    ca-certificates \
    wget \
    curl \
    build-essential \
    nodejs \
 && apt-get clean \
 && rm -r /var/lib/apt/lists/*

# Configure Nginx and apply fix for very long server names
RUN sed -i 's/^http {/&\n    server_names_hash_bucket_size 128;/g' /etc/nginx/nginx.conf

COPY app /app/
COPY confd /etc/nginx/vhosts.d
WORKDIR /app/

RUN mkdir /etc/nginx/logs
RUN chmod u+x /app/docker-entrypoint.sh /app/app.js

ENV RANCHER_METADATA_HOST http://rancher-metadata:8080
ENV RANCHER_VERSION v1
ENV NGINX_CMD nginx
ENV IP_FIELD dockerIp

VOLUME ["/etc/nginx/certs", "/etc/nginx/conf.d"]
VOLUME ["/etc/nginx/vhosts.d"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]

CMD ["nodejs", "app.js"]
