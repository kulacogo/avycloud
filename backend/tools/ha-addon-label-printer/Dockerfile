FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    cups \
    cups-filters \
    cups-client \
    cups-ipp-utils \
    poppler-utils \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY label-print-proxy.js /app/
COPY run.sh /run.sh
RUN chmod a+x /run.sh

ENTRYPOINT []
CMD ["/run.sh"]
