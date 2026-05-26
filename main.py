import json
import os
import logging
from datetime import datetime, timedelta
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy import create_engine, Column, String, Integer, Text, ForeignKey
from sqlalchemy.orm import declarative_base, sessionmaker, Session

# --- НАСТРОЙКИ ---
CONFIG_PATH = os.path.join("config", "site.json")
DATA_DIR = "data"
DB_PATH = os.path.join(DATA_DIR, "clinic.sqlite")
SQLALCHEMY_DATABASE_URL = f"sqlite:///{DB_PATH}"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Убедимся, что папка data существует
os.makedirs(DATA_DIR, exist_ok=True)

# --- БАЗА ДАННЫХ (SQLAlchemy ORM) ---
engine = create_engine(
    SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False}
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

# --- МОДЕЛИ SQLAlchemy ---
class Service(Base):
    __tablename__ = "services"
    id = Column(String, primary_key=True)
    title = Column(Text, nullable=False)
    description = Column(Text, nullable=False)
    price_from = Column(Integer, nullable=False)
    icon = Column(Text, nullable=False)
    sort_order = Column(Integer, default=0)
    active = Column(Integer, default=1)

class Slot(Base):
    __tablename__ = "slots"
    id = Column(String, primary_key=True)
    starts_at = Column(Text, nullable=False, unique=True)
    duration_minutes = Column(Integer, default=60)
    active = Column(Integer, default=1)

class Booking(Base):
    __tablename__ = "bookings"
    id = Column(String, primary_key=True)
    slot_id = Column(String, ForeignKey("slots.id", ondelete="RESTRICT"), nullable=False)
    service_id = Column(String, ForeignKey("services.id", ondelete="RESTRICT"), nullable=False)
    patient_name = Column(Text, nullable=False)
    phone = Column(Text, nullable=False)
    messenger = Column(Text, default="whatsapp")
    comment = Column(Text, default="")
    privacy_accepted_at = Column(Text, default="")
    status = Column(Text, default="new")
    created_at = Column(Text, nullable=False)

# --- СХЕМЫ PYDANTIC ---
class SiteConfigPublic(BaseModel):
    clinic: dict
    seo: dict
    hero: dict
    legal: dict

class ServicePublic(BaseModel):
    id: str
    title: str
    description: str
    priceFrom: int = Field(alias="price_from")
    icon: str
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

class SlotPublic(BaseModel):
    id: str
    starts_at: str
    available: bool = True
    dateLabel: str = ""
    timeLabel: str = ""
    model_config = ConfigDict(from_attributes=True)

class BookingCreate(BaseModel):
    slotId: str
    serviceId: str
    patientName: str = Field(min_length=2)
    phone: str
    messenger: str
    comment: str = Field(default="", max_length=700)
    privacyAccepted: str | bool | int

class BookingPublic(BaseModel):
    id: str
    status: str
    model_config = ConfigDict(from_attributes=True)

class AdminBookingPublic(BaseModel):
    id: str
    patient_name: str
    phone: str
    messenger: str
    comment: str
    status: str
    created_at: str
    dateLabel: str = ""
    timeLabel: str = ""
    priceLabel: str = ""
    service_title: str = ""
    model_config = ConfigDict(from_attributes=True)

class StatusUpdate(BaseModel):
    status: str

# --- ЛОГИКА СИДИНГА ---
def date_only_local():
    return datetime.now()

def seed_database():
    Base.metadata.create_all(bind=engine)
    
    if not os.path.exists(CONFIG_PATH):
        logger.warning(f"Конфиг {CONFIG_PATH} не найден!")
        return

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config_data = json.load(f)

    with SessionLocal() as db:
        # Услуги
        for s_data in config_data.get("services", []):
            service = db.query(Service).filter(Service.id == s_data["id"]).first()
            if not service:
                service = Service(id=s_data["id"])
            service.title = s_data["title"]
            service.description = s_data["description"]
            service.price_from = s_data["priceFrom"]
            service.icon = s_data["icon"]
            service.sort_order = s_data["sortOrder"]
            service.active = 1
            db.merge(service)
        
        # Слоты
        schedule_cfg = config_data.get("schedule", {})
        days_to_generate = schedule_cfg.get("daysToGenerate", 14)
        duration = schedule_cfg.get("durationMinutes", 60)
        weekday_times = schedule_cfg.get("weekdayTimes", [])
        saturday_times = schedule_cfg.get("saturdayTimes", [])

        now = date_only_local()
        for i in range(days_to_generate):
            current_date = now + timedelta(days=i)
            weekday = current_date.weekday()
            if weekday == 6:  # Пропускаем воскресенье
                continue
                
            times = saturday_times if weekday == 5 else weekday_times
            date_str = current_date.strftime("%Y-%m-%d")
            
            for t in times:
                time_clean = t.replace(":", "")
                slot_id = f"slot-{date_str}-{time_clean}"
                starts_at = f"{date_str} {t}"
                
                slot = db.query(Slot).filter(Slot.id == slot_id).first()
                if not slot:
                    slot = Slot(id=slot_id)
                slot.starts_at = starts_at
                slot.duration_minutes = duration
                slot.active = 1
                db.merge(slot)

        db.commit()
        logger.info("БД и слоты успешно инициализированы")

@asynccontextmanager
async def lifespan(app: FastAPI):
    seed_database()
    yield

# --- ИНИЦИАЛИЗАЦИЯ FASTAPI ---
app = FastAPI(title="Подолог API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- ENDPOINTS (Часть 1) ---
@app.get("/api/health")
def health_check():
    return {"ok": True}

@app.get("/api/site", response_model=SiteConfigPublic)
def get_site_config():
    if not os.path.exists(CONFIG_PATH):
        raise HTTPException(status_code=500, detail="Config missing")
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {
        "clinic": data.get("clinic", {}),
        "seo": data.get("seo", {}),
        "hero": data.get("hero", {}),
        "legal": data.get("legal", {})
    }

# Подключение статики (должно быть в конце)
os.makedirs("static", exist_ok=True)
app.mount("/", StaticFiles(directory="static", html=True), name="static")
