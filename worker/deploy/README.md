# Run the worker on a free VM

The worker has to stay connected to WhatsApp 24/7 and keep its files (WhatsApp session, HighLevel tokens), so it needs an always-on machine with a disk. Free hosts that sleep or wipe the disk (Render free, Vercel functions) will not work. These do:

| Host | Free resources | Notes |
|---|---|---|
| Google Cloud e2-micro | 1 VM (2 shared vCPU, 1 GB RAM), 30 GB standard disk, 1 GB egress/month | Only free in us-west1, us-central1, us-east1. Choose the *standard* persistent disk. |
| Oracle Cloud Always Free | Ampere A1: 2 OCPU / 12 GB RAM, 200 GB block storage | Plenty of headroom. Free-tier-only accounts can have idle VMs reclaimed; upgrading the account to Pay As You Go (still $0 within limits) avoids that. |
| Any VPS (Hetzner, etc.) | — | Not free (≈ €4/month) but the same steps apply. |

The bridge itself uses about 150–300 MB of RAM.

## 1. Create the VM

- Ubuntu 24.04 or Debian 12, x86 or ARM both work.
- Open inbound TCP ports **80** and **443** (Google Cloud: tick "Allow HTTP/HTTPS traffic"; Oracle: add ingress rules to the subnet's security list *and* allow them in the VM firewall).
- Note the VM's public IP.

On a 1 GB machine add swap so the image build does not run out of memory:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 2. Point a hostname at it

Caddy gets a free HTTPS certificate automatically, but it needs a hostname:

- a subdomain of a domain you own, e.g. an `A` record `wa-worker.yourdomain.com → <VM IP>`, or
- a free `yourname.duckdns.org` from duckdns.org pointed at the VM IP.

## 3. Install Docker and start the worker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker

git clone https://github.com/Mayurkoli8/SparkOs-WhatsApp.git
cd SparkOs-WhatsApp/worker/deploy
cp .env.example .env
nano .env          # fill in every value (same values as on Railway)
docker compose up -d --build
```

Check it: `curl https://<WORKER_DOMAIN>/health` should return `{"ok":true,...}`. Logs: `docker compose logs -f worker`.

To update after new commits: `git pull && docker compose up -d --build`.

### Google Cloud shortcut

`gce-startup.sh` does steps 1–3 by itself on a Compute Engine VM (swap, Docker, clone, `.env`, start) and uses `<ip>.sslip.io` as the hostname. This is how the current worker was created (project `sparkwa`):

```bash
gcloud services enable compute.googleapis.com
gcloud compute firewall-rules create wa-bridge-allow-web --network=default --allow=tcp:80,tcp:443 --target-tags=wa-bridge
gcloud compute instances create wa-bridge --zone=us-central1-a --machine-type=e2-micro \
  --image-family=debian-12 --image-project=debian-cloud --boot-disk-size=30GB --boot-disk-type=pd-standard \
  --tags=wa-bridge --metadata-from-file=startup-script=gce-startup.sh \
  --metadata=internal-api-key=<same as Vercel WORKER_API_KEY>,ghl-client-id=<client id>,ghl-provider-id=<provider id>,inbound-type=Custom,token-refresh-url=https://<vercel-domain>/api/oauth/refresh
gcloud compute instances get-serial-port-output wa-bridge --zone=us-central1-a | grep WA-BRIDGE   # waits for "READY https://…"
```

Every boot pulls the latest code and rebuilds, so `gcloud compute instances reset wa-bridge --zone=us-central1-a` deploys new commits. Use reset/reboot, not stop/start: stopping releases the ephemeral IP and the sslip.io hostname would change.

## 4. Switch the dashboard over

1. On Railway, stop the worker service (two workers using the same WhatsApp login knock each other offline).
2. In Vercel → Settings → Environment Variables set `WORKER_URL=https://<WORKER_DOMAIN>` and `WORKER_API_KEY` to the `INTERNAL_API_KEY` from `.env`, then redeploy.
3. Open the dashboard, click **Connect GHL** (the new worker starts without tokens), create the WhatsApp instance and scan the QR code.
4. The provider's Delivery URL in the Marketplace app stays `https://<your-vercel-domain>/api/oauth/outbound`; nothing changes in HighLevel.

Setup status on the dashboard should be all green, including "Data is stored on …" once the worker runs here (the Railway volume check no longer applies; the Docker volume `worker-data` is persistent).
