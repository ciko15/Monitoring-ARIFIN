import struct

hex_data = "89 26 00 ff 07 b8 03 01 00 2c c8 44 04 10 00 00 46 78 00 18 ff 07 a3 03 01 00 2c c8 44 04 10 00 00 00 84 00 18 bf 31 9a a1"
buf = bytes.fromhex(hex_data.replace(" ", ""))

print(f"Length: {len(buf)}")

for i in range(len(buf) - 1):
    val_u16 = struct.unpack_from("<H", buf, i)[0]
    val_i16 = struct.unpack_from("<h", buf, i)[0]
    print(f"Offset {i}: U16={val_u16} I16={val_i16}")

