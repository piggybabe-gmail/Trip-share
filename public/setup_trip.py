#!/usr/bin/env python3
"""Trip Share ชิงเต่า — ติดตั้งระบบสิทธิ์ (รันครั้งเดียวใน Google Cloud Shell ของโปรเจกต์ trip-share-aead6)

ทำ 4 อย่าง:
  1) เปิดการล็อกอินแบบชื่อผู้ใช้ + รหัสผ่าน (Email/Password ใน Firebase Authentication)
  2) ติดตั้งกฎสิทธิ์ Firestore (firestore.rules จาก GitHub repo นี้)
  3) สร้างบัญชีผู้จัดทริป — ถามชื่อผู้ใช้และรหัสผ่านตอนรัน รหัสผ่านไม่ถูกเก็บหรือแสดงที่ไหน
  4) ตรวจว่าคนทั่วไปอ่านข้อมูลลับไม่ได้จริง

วิธีรัน:  curl -sL https://raw.githubusercontent.com/piggybabe-gmail/trip-share/main/setup_trip.py -o ~/setup_trip.py && python3 ~/setup_trip.py
"""
import getpass, json, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

P = "trip-share-aead6"
TRIP = "qingdao"
API_KEY = "AIzaSyAQpDb3dXWRDHU4gJveD4pfFkUYuXxNtWg"
RAW = "https://raw.githubusercontent.com/piggybabe-gmail/trip-share/main/firestore.rules"
DOMAIN = "users.trip-share.app"
FS = f"https://firestore.googleapis.com/v1/projects/{P}/databases/(default)/documents"


def die(msg):
    sys.exit("\n❌ " + msg + "\nแคปหน้าจอส่งให้อินังได้เลย")


try:
    TOKEN = subprocess.check_output(["gcloud", "auth", "print-access-token"], stderr=subprocess.DEVNULL).decode().strip()
except Exception:
    die("ขอสิทธิ์ Google ไม่ได้ ถ้ามีกล่อง Authorize ให้กด Authorize แล้วรันคำสั่งเดิมอีกครั้ง")


def call(method, url, body=None, auth=True, ok=(200,), extra=None):
    h = {"Content-Type": "application/json", "Referer": f"https://{P}.web.app/"}
    if auth:
        h["Authorization"] = "Bearer " + TOKEN
        h["x-goog-user-project"] = P
    if extra:
        h.update(extra)
    req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw.strip() else {})
    except urllib.error.HTTPError as e:
        txt = e.read().decode(errors="replace")
        try:
            data = json.loads(txt)
        except Exception:
            data = {"raw": txt}
        if e.code in ok:
            return e.code, data
        return e.code, data


def fs_fields(d):
    out = {}
    for k, v in d.items():
        if isinstance(v, bool):
            out[k] = {"booleanValue": v}
        elif isinstance(v, (int, float)):
            out[k] = {"doubleValue": v}
        elif v == "__NOW__":
            out[k] = {"timestampValue": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        else:
            out[k] = {"stringValue": str(v)}
    return {"fields": out}


def doc_url(path):
    return FS + "/" + "/".join(urllib.parse.quote(seg, safe="") for seg in path.split("/"))


print("\n🦚 Trip Share ชิงเต่า — ติดตั้งระบบสิทธิ์\n")

# ---------- 1) Email/Password sign-in ----------
st, cfg = call("GET", f"https://identitytoolkit.googleapis.com/admin/v2/projects/{P}/config")
if st != 200:
    die("อ่านการตั้งค่า Authentication ไม่ได้ (%s): %s" % (st, json.dumps(cfg)[:300]))
if cfg.get("signIn", {}).get("email", {}).get("enabled") and cfg["signIn"]["email"].get("passwordRequired"):
    print("1) ระบบล็อกอินด้วยรหัสผ่าน: เปิดอยู่แล้ว ✓")
else:
    st, r = call("PATCH", f"https://identitytoolkit.googleapis.com/admin/v2/projects/{P}/config?updateMask=signIn.email",
                 {"signIn": {"email": {"enabled": True, "passwordRequired": True}}})
    if st != 200:
        die("เปิดระบบล็อกอินไม่สำเร็จ (%s): %s" % (st, json.dumps(r)[:300]))
    print("1) เปิดระบบล็อกอินด้วยชื่อผู้ใช้ + รหัสผ่าน ✓")
if not cfg.get("signIn", {}).get("anonymous", {}).get("enabled"):
    call("PATCH", f"https://identitytoolkit.googleapis.com/admin/v2/projects/{P}/config?updateMask=signIn.anonymous", {"signIn": {"anonymous": {"enabled": True}}})

# ---------- 2) Firestore rules ----------
try:
    rules = urllib.request.urlopen(urllib.request.Request(RAW + "?n=%d" % time.time(), headers={"Cache-Control": "no-cache"}), timeout=60).read().decode()
except Exception as e:
    die("โหลดไฟล์ firestore.rules จาก GitHub ไม่ได้: %s" % e)
if "v3: owner-managed" not in rules:
    die("ไฟล์ firestore.rules บน GitHub ยังเป็นเวอร์ชันเก่า อัปโหลดไฟล์ใหม่ขึ้น GitHub ก่อน แล้วรอ 1 นาทีค่อยรันคำสั่งนี้อีกครั้ง")
st, rs = call("POST", f"https://firebaserules.googleapis.com/v1/projects/{P}/rulesets", {"source": {"files": [{"name": "firestore.rules", "content": rules}]}})
if st != 200:
    die("กฎสิทธิ์มีข้อผิดพลาด ยังไม่ได้ติดตั้ง (%s): %s" % (st, json.dumps(rs, ensure_ascii=False)[:800]))
rel = f"projects/{P}/releases/cloud.firestore"
st, r = call("PATCH", f"https://firebaserules.googleapis.com/v1/{rel}", {"release": {"name": rel, "rulesetName": rs["name"]}})
if st == 404:
    st, r = call("POST", f"https://firebaserules.googleapis.com/v1/projects/{P}/releases", {"name": rel, "rulesetName": rs["name"]})
if st != 200:
    die("ติดตั้งกฎสิทธิ์ไม่สำเร็จ (%s): %s" % (st, json.dumps(r)[:300]))
print("2) ติดตั้งกฎสิทธิ์ Firestore ✓")

# ---------- 3) Owner account ----------
st, owner = call("GET", doc_url(f"trips/{TRIP}/config/owner"), ok=(200, 404))
if st == 200 and owner.get("fields", {}).get("uid"):
    uname = owner["fields"].get("username", {}).get("stringValue", "")
    print(f"3) มีบัญชีผู้จัดทริปอยู่แล้ว (ชื่อผู้ใช้: {uname}) ✓")
else:
    print("\n3) สร้างบัญชีผู้จัดทริป (ใช้เข้าเว็บ ปุ่ม “เข้าสู่ระบบ” มุมขวาบน)")
    while True:
        uname = input("   ตั้งชื่อผู้ใช้ของคุณ (เช่น nokyung) แล้วกด Enter: ").strip()
        key = " ".join(uname.lower().split())
        if key and "/" not in key and len(key) <= 40:
            st, ex = call("GET", doc_url(f"trips/{TRIP}/logins/{key}"), ok=(200, 404))
            if st == 404:
                break
            print("   ชื่อนี้มีคนใช้แล้ว ลองชื่ออื่น")
        else:
            print("   ชื่อผู้ใช้ห้ามว่าง ห้ามมี / และยาวไม่เกิน 40 ตัว")
    while True:
        pw = getpass.getpass("   ตั้งรหัสผ่าน (อย่างน้อย 8 ตัว ตอนพิมพ์จะไม่ขึ้นบนจอ) แล้วกด Enter: ")
        pw2 = getpass.getpass("   พิมพ์รหัสผ่านซ้ำอีกครั้ง แล้วกด Enter: ")
        if len(pw) < 8:
            print("   รหัสผ่านสั้นเกินไป")
        elif pw != pw2:
            print("   รหัสผ่านสองครั้งไม่ตรงกัน ลองใหม่")
        else:
            break
    email = "owner-" + str(int(time.time())) + "@" + DOMAIN
    st, u = call("POST", f"https://identitytoolkit.googleapis.com/v1/projects/{P}/accounts", {"email": email, "password": pw, "displayName": uname})
    if st != 200 or "localId" not in u:
        die("สร้างบัญชีไม่สำเร็จ (%s): %s" % (st, json.dumps(u)[:300]))
    pw = pw2 = None
    uid = u["localId"]
    for path, data in [(f"trips/{TRIP}/logins/{key}", {"email": email}), (f"trips/{TRIP}/config/owner", {"uid": uid, "username": uname, "createdAt": "__NOW__"})]:
        st, r = call("PATCH", doc_url(path), fs_fields(data))
        if st != 200:
            die("บันทึกบัญชีเจ้าของไม่สำเร็จ (%s): %s" % (st, json.dumps(r)[:300]))
    print(f"   สร้างบัญชีผู้จัดทริปแล้ว ชื่อผู้ใช้: {uname} ✓")

# ---------- 4) Check: the public cannot read private data ----------
st, a = call("POST", f"https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={API_KEY}", {"returnSecureToken": True}, auth=False)
if st == 200 and a.get("idToken"):
    anon = {"Authorization": "Bearer " + a["idToken"]}
    time.sleep(3)
    s1, _ = call("GET", FS + f"/trips/{TRIP}/signups?pageSize=1", auth=False, ok=(200, 403), extra=anon)
    s2, _ = call("GET", FS + f"/trips/{TRIP}/expenses?pageSize=1", auth=False, ok=(200, 403), extra=anon)
    s3, _ = call("GET", FS + f"/trips/{TRIP}/signupContact?pageSize=1", auth=False, ok=(200, 403), extra=anon)
    good = s1 == 200 and s2 == 403 and s3 == 403
    print("4) ตรวจสิทธิ์คนทั่วไป: เห็นรายชื่อ %s · ค่าใช้จ่ายถูกล็อก %s · เบอร์ติดต่อถูกล็อก %s" % ("✓" if s1 == 200 else "✗", "✓" if s2 == 403 else "✗", "✓" if s3 == 403 else "✗"))
    if not good:
        print("   ⚠️ ผลไม่ตรงที่ควรเป็น รอ 1 นาทีแล้วรันคำสั่งนี้อีกครั้ง ถ้ายังเหมือนเดิมแคปหน้าจอส่งอินัง")
    # remove the throwaway anonymous user
    call("POST", f"https://identitytoolkit.googleapis.com/v1/projects/{P}/accounts:delete", {"localId": a.get("localId")})
else:
    print("4) ข้ามการตรวจสิทธิ์ (สร้างผู้ใช้ทดสอบไม่ได้) ไม่เป็นไร")

print("\n✅ เสร็จแล้ว! เปิด https://%s.web.app กด “เข้าสู่ระบบ” ด้วยชื่อผู้ใช้ที่ตั้งไว้" % P)
print("   จากนั้นไปแท็บ “จัดการทริป” กด “นี่คือฉัน” ที่ชื่อของคุณ แล้วเริ่มยืนยันเพื่อนได้เลย\n")
