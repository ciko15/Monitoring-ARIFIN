import sys
import struct

try:
    from scapy.all import rdpcap, TCP, UDP, Raw
except ImportError:
    import os
    os.system("pip install scapy > /dev/null 2>&1")
    from scapy.all import rdpcap, TCP, UDP, Raw

def main():
    pcap_file = "Sample pcap/ILS MM.pcap"
    packets = rdpcap(pcap_file)
    
    unique_payloads = []
    
    for pkt in packets:
        if pkt.haslayer(Raw):
            payload = bytes(pkt[Raw].load)
            if payload not in unique_payloads:
                unique_payloads.append(payload)
                if len(unique_payloads) > 20:
                    break
                    
    for i, p in enumerate(unique_payloads):
        print(f"Payload {i+1} (Length: {len(p)}):")
        print("Hex:", p.hex())
        try:
            print("Ascii:", p.decode('ascii', errors='ignore'))
        except:
            pass
        print("-" * 50)

if __name__ == "__main__":
    main()
