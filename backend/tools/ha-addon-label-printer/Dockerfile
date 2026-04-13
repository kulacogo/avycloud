FROM python:3.11-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    poppler-utils \
    nodejs \
    && pip install --no-cache-dir brother_ql_inventree \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY label-print-proxy.js /app/
COPY run.sh /run.sh
RUN chmod a+x /run.sh

ENTRYPOINT []
CMD ["/run.sh"]
