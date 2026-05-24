#!/bin/bash
# Find the primary local IP address of the Linux host
LAN_IP=$(hostname -I | awk '{print $1}')

# Push it directly to the JJTV API database to override the Docker IP
curl -X POST http://tv.sriviz.com/admin-api/settings \
     -H "Content-Type: application/json" \
     -d "{\"server_lan_ip\":\"$LAN_IP\"}"

echo "Successfully pushed LAN IP: $LAN_IP"
