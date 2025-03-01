<div align="center">

<img src="master\public\assets\img\fxfurtrack.png" alt="FxFurTrack" height="90">

## Embed FurTrack photos everywhere (fast)

</div>

This project provides a scraping service that extracts OpenGraph (OG) metadata from FurTrack pages. It uses a **Master-Worker** architecture where the master handles requests and workers to fetch and extract metadata dynamically.

---

## Installation & Setup

### **1. Prerequisites**
Ensure you have the following installed:
- [Docker](https://docs.docker.com/get-docker/)
- [Docker Compose](https://docs.docker.com/compose/install/)

### **2. Clone the Repository**
```bash
git clone https://github.com/blumlaut/fxfurtrack.git
cd fxfurtrack
```

### **3. Configure Environment Variables**
FurTrack **may** limit connections from non-logged in users, to ensure this does not happen fxfurtrack supports configuring your own Token in the `.env` file.

### **4. Start the Services**
Run the following command to build and start all services:
```bash
docker compose up --build
```
This will start:
- **Redis** (for job queuing and caching)
- **Master API** (handles requests)
- **Worker(s)** (retrieves OpenGraph metadata)

## Disclaimer
Please note that this project is not affiliated with or endorsed by FurTrack.