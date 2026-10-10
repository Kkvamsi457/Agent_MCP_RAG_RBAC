
import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime, timezone

from bson import ObjectId
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pymongo import MongoClient
from pymongo.errors import DuplicateKeyError

from .config import BASE_DIR


MONGO_URL = os.getenv("MONGODB_URL", "mongodb://127.0.0.1:27017")
MONGO_DB = os.getenv("MONGODB_DB", "atlas_agentic_rag")

client = MongoClient(MONGO_URL, serverSelectionTimeoutMS=5000)
db = client[MONGO_DB]

users = db["users"]
roles = db["roles"]
permissions = db["permissions"]
prompts = db["prompts"]

SECRET = os.getenv("AUTH_SECRET_KEY", "")
TOKEN_TTL = int(os.getenv("AUTH_TOKEN_TTL_SECONDS", "28800"))

# Registers HTTP Bearer authentication in FastAPI's OpenAPI schema.
# Swagger UI will show the Authorize button.
bearer_scheme = HTTPBearer(auto_error=False)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode(),
        bytes.fromhex(salt),
        310_000,
    )
    return f"pbkdf2_sha256${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, salt, expected = stored.split("$", 2)
        if algorithm != "pbkdf2_sha256":
            return False

        actual = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode(),
            bytes.fromhex(salt),
            310_000,
        ).hex()

        return hmac.compare_digest(actual, expected)
    except Exception:
        return False


def _issue_token(user: dict) -> str:
    payload = {
        "sub": str(user["_id"]),
        "username": user["username"],
        "role_id": str(user["role_id"]),
        "role_code": user["role_code"],
        "exp": int(time.time()) + TOKEN_TTL,
    }

    raw = _b64(json.dumps(payload, separators=(",", ":")).encode())
    signature = _b64(
        hmac.new(SECRET.encode(), raw.encode(), hashlib.sha256).digest()
    )

    return f"{raw}.{signature}"


def _decode_token(token: str):
    if not SECRET:
        return None

    try:
        raw, signature = token.split(".", 1)
        expected = _b64(
            hmac.new(SECRET.encode(), raw.encode(), hashlib.sha256).digest()
        )

        if not hmac.compare_digest(signature, expected):
            return None

        payload = json.loads(_unb64(raw))

        if int(payload["exp"]) <= int(time.time()):
            return None

        return payload
    except Exception:
        return None


def seed_database():
    if not SECRET or len(SECRET) < 32:
        raise RuntimeError(
            "AUTH_SECRET_KEY must be set to a random value of at least "
            "32 characters in backend/.env"
        )

    roles.create_index("code", unique=True)
    users.create_index("username", unique=True)
    permissions.create_index("code", unique=True)
    prompts.create_index("code", unique=True)

    admin_perm = {
        "prompts.read": True,
        "prompts.create": True,
        "prompts.update": True,
        "prompts.delete": True,
    }
    user_perm = {
        "prompts.read": False,
        "prompts.create": False,
        "prompts.update": False,
        "prompts.delete": False,
    }

    for code, name, grants in [
        ("admin", "Administrator", admin_perm),
        ("user", "User", user_perm),
    ]:
        roles.update_one(
            {"code": code},
            {
                "$setOnInsert": {
                    "code": code,
                    "name": name,
                    "is_active": True,
                }
            },
            upsert=True,
        )

        role = roles.find_one({"code": code})
        permissions.update_one(
            {"code": f"{code}_permissions"},
            {
                "$set": {
                    "role_id": role["_id"],
                    "grants": grants,
                }
            },
            upsert=True,
        )

    username = os.getenv("ADMIN_USERNAME", "admin").strip()
    password = os.getenv("ADMIN_PASSWORD", "")

    if not password:
        raise RuntimeError("Set ADMIN_PASSWORD in backend/.env")

    admin_role = roles.find_one({"code": "admin"})
    existing = users.find_one({"username": username})

    # Create the configured admin only if the account does not already exist.
    # Existing passwords are never overwritten on application restart.
    if existing is None:
        users.insert_one(
            {
                "username": username,
                "display_name": username,
                "password_hash": hash_password(password),
                "role_id": admin_role["_id"],
                "is_active": True,
                "created_at": datetime.now(timezone.utc),
            }
        )

    # Safe, additive migration for legacy records.
    for legacy in users.find({"role_id": {"$exists": False}}):
        role_code = str(legacy.get("role", "user")).lower()
        role_doc = roles.find_one({"code": role_code})
        if not role_doc:
            role_doc = roles.find_one({"code": "user"})

        if role_doc:
            users.update_one(
                {"_id": legacy["_id"]},
                {"$set": {"role_id": role_doc["_id"]}},
            )


def authenticate(username: str, password: str):
    user = users.find_one(
        {"username": username.strip(), "is_active": True}
    )
    if not user or not verify_password(
        password, user.get("password_hash", "")
    ):
        return None

    role = roles.find_one(
        {"_id": user.get("role_id"), "is_active": True}
    )
    if not role:
        return None

    user["role_code"] = role["code"]
    user["role_name"] = role["name"]
    return user


def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
):
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Please sign in.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    claims = _decode_token(credentials.credentials)
    if not claims:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        oid = ObjectId(claims["sub"])
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token.",
        )

    user = users.find_one({"_id": oid, "is_active": True})
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Account is inactive or no longer exists.",
        )

    role = roles.find_one(
        {"_id": user.get("role_id"), "is_active": True}
    )
    if not role:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your role is inactive.",
        )

    return {
        "id": str(user["_id"]),
        "username": user["username"],
        "display_name": user.get("display_name", user["username"]),
        "role_id": str(role["_id"]),
        "role_code": role["code"],
        "role_name": role["name"],
    }


def require_admin(user=None, action="read"):
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Please sign in.",
        )

    try:
        role_id = ObjectId(user["role_id"])
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid user role.",
        )

    grant = permissions.find_one({"role_id": role_id})
    allowed = bool(
        grant
        and grant.get("grants", {}).get(f"prompts.{action}", False)
    )

    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Forbidden: you do not have access to prompts.",
        )

    return user


def register_user(
    username: str,
    password: str,
    display_name: str,
    role_code: str = "user",
):
    username = username.strip()
    display_name = display_name.strip()

    if not username or not password or not display_name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Username, password and display name are required.",
        )

    if role_code not in {"admin", "user"}:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="role_code must be 'admin' or 'user'.",
        )

    role = roles.find_one({"code": role_code, "is_active": True})
    if not role:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The requested role is not configured or active.",
        )

    now = datetime.now(timezone.utc)
    document = {
        "username": username,
        "display_name": display_name,
        "password_hash": hash_password(password),
        "role_id": role["_id"],
        "is_active": True,
        "created_at": now,
    }

    try:
        result = users.insert_one(document)
    except DuplicateKeyError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A user with this username already exists.",
        )

    return {
        "id": str(result.inserted_id),
        "username": username,
        "display_name": display_name,
        "role_code": role["code"],
        "role_name": role["name"],
        "message": "User registered successfully.",
    }


def get_prompt(code: str) -> str:
    """Fetch an active prompt from MongoDB; never use embedded fallback text."""
    try:
        item = prompts.find_one({"code": code, "is_active": True})
    except Exception as exc:
        raise RuntimeError(
            f"Unable to load prompt '{code}' from MongoDB: {exc}"
        ) from exc

    if (
        not item
        or not isinstance(item.get("content"), str)
        or not item["content"].strip()
    ):
        raise RuntimeError(
            f"Required active prompt '{code}' is missing from MongoDB. "
            "Run `python seed_prompts.py` from the backend folder."
        )

    return item["content"]


def _issue(user):
    return _issue_token(user)
