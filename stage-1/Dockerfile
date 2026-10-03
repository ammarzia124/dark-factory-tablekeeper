FROM python:3.12-slim-bookworm

# zoneinfo reads the system database; tzdata guarantees the IANA zones the
# fixtures name are present. Everything is baked in -- the container never needs
# the network at run time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY app.py /app/app.py

ENV PORT=8080
EXPOSE 8080

CMD ["python", "/app/app.py"]