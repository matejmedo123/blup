# Trader — the 24/7 autopilot and the dashboard in one small image (stdlib Python, no dependencies).
#
#   docker compose -f deploy/docker-compose.yml up -d --build      # see deploy/README.md
#
# Build from the trader-skill folder (the build context is the folder above this one):
#   docker build -f deploy/Dockerfile -t trader-skill .
#   docker build -f deploy/Dockerfile --build-arg WITH_AI=1 -t trader-skill .   # + the optional AI desk SDK
FROM python:3.12-slim

# 1 = also install the Anthropic SDK for the optional AI desk (ai_desk.enabled in config.json)
ARG WITH_AI=0
# pin it if you like, e.g. --build-arg ANTHROPIC_SPEC="==1.2.3"
ARG ANTHROPIC_SPEC=""

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    TRADER_HOME=/data/trader \
    TRADER_PACK_ROOT=/opt/trader

RUN if [ "$WITH_AI" = "1" ]; then pip install --no-cache-dir "anthropic${ANTHROPIC_SPEC}"; fi \
 && useradd --system --uid 10001 --create-home --home-dir /home/trader --shell /usr/sbin/nologin trader \
 && mkdir -p /data/trader \
 && chown -R trader:trader /data

# the code is owned by root and read-only for the bot; all state lives in the /data volume
COPY --chown=root:root . /opt/trader
WORKDIR /opt/trader
USER trader
VOLUME ["/data"]
EXPOSE 8765

# unhealthy = no autopilot heartbeat for 3 × interval (min 3 min); the dashboard service overrides this
HEALTHCHECK --interval=2m --timeout=10s --start-period=5m --retries=2 \
  CMD ["python3", "/opt/trader/deploy/healthcheck.py"]

# --approve = standing approval for orders that pass every gate (simulator / paper unless you opt in to live)
CMD ["python3", "trader-autopilot/autopilot.py", "daemon", "--approve"]
