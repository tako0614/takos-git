FROM denoland/deno:2.8.2

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --chown=deno:deno deno.json deno.lock ./
COPY --chown=deno:deno apps ./apps
COPY --chown=deno:deno packages ./packages
RUN mkdir -p node_modules /workspace/node_modules \
  && chown -R deno:deno node_modules /workspace

USER deno
RUN deno cache apps/git/src/index.ts

ENV PORT=8790
EXPOSE 8790

CMD ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-run=git", "apps/git/src/index.ts"]
