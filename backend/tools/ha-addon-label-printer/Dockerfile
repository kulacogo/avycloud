ARG BUILD_FROM=node:20-alpine
FROM ${BUILD_FROM}

COPY label-print-proxy.js /app/
COPY run.sh /run.sh
RUN chmod +x /run.sh

CMD ["/run.sh"]
