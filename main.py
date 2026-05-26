import json
import os
import logging
import uuid
import re
from datetime import datetime, timedelta
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Depends, Header
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ConfigDict, field_validator
from sqlalchemy import create_engine, Column, String, Integer, Text, ForeignKey
from sqlalchemy.orm import declarative_base, sessionmaker, Session, relationship, joinedload

# --- НАСТРОЙКИ ---
CONFIG_PATH = os.path.join("config", "site.json")
DATA_DIR = "data"
DB_PATH = os.path.join(DATA_DIR, "clinic.sqlite")
SQLALCHEMY_DATABASE_URL = f"sqlite:///{DB_PATH}"

ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "dev-admin")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
if ADMIN_TOKEN == "dev-admin":
    logger.warning("ВНИМАНИЕ: Используется стандартный пароль админа 'dev-admin'. В продакшене задайте переменную окружения ADMIN_TOKEN.")

os.makedirs(DATA_DIR, exist_ok=True)

# --- БАЗА ДАННЫХ ---
engine = create_engine(SQLALCHEMY_DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

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
    
    slot = relationship("Slot", lazy="joined")
    service = relationship("Service", lazy="joined")

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
    phone: str = Field(pattern=r"^\+?[0-9\s().-]{7,24}$")
    messenger: str
    comment: str = Field(default="", max_length=700)
    privacyAccepted: str | bool | int

    @field_validator('messenger')
    @classmethod
    def validate_messenger(cls, v: str):
        if v not in ['whatsapp', 'telegram', 'phone']:
            raise ValueError("Допустимые значения: whatsapp, telegram, phone")
        return v
        
    @field_validator('privacyAccepted')
    @classmethod
    def validate_privacy(cls, v):
        if str(v).lower() not in ['on', 'true', 'yes', '1']:
            raise ValueError("Необходимо согласие на обработку данных")
        return v

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

    @field_validator('status')
    @classmethod
    def validate_status(cls, v: str):
        if v not in ['new', 'confirmed', 'done', 'cancelled']:
            raise ValueError("Неверный статус")
        return v

# --- ХЕЛПЕРЫ ---
MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"]
WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"]

def format_ru_date(dt_str: str) -> tuple[str, str]:
    try:
        dt = datetime.strptime(dt_str, "%Y-%m-%d %H:%M")
        date_label = f"{dt.day} {MONTHS[dt.month - 1]}, {WEEKDAYS[dt.weekday()]}"
        time_label = dt.strftime("%H:%M")
        return date_label, time_label
    except Exception:
        return dt_str, ""

def verify_admin_token(x_admin_token: str = Header(None)):
    if x_admin_token != ADMIN_TOKEN:
        raise HTTPException(status_code=401, detail="Неверный токен администратора")

# --- ЛОГИКА СИДИНГА ---
def seed_database():
    Base.metadata.create_all(bind=engine)
    if not os.path.exists(CONFIG_PATH):
        return

    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config_data = json.load(f)

    with SessionLocal() as db:
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
        
        schedule_cfg = config_data.get("schedule", {})
        days_to_generate = schedule_cfg.get("daysToGenerate", 14)
        duration = schedule_cfg.get("durationMinutes", 60)
        
        now = datetime.now()
        for i in range(days_to_generate):
            current_date = now + timedelta(days=i)
            weekday = current_date.weekday()
            if weekday == 6: continue
                
            times = schedule_cfg.get("saturdayTimes", []) if weekday == 5 else schedule_cfg.get("weekdayTimes", [])
            date_str = current_date.strftime("%Y-%m-%d")
            
            for t in times:
                slot_id = f"slot-{date_str}-{t.replace(':', '')}"
                slot = db.query(Slot).filter(Slot.id == slot_id).first()
                if not slot:
                    slot = Slot(id=slot_id)
                slot.starts_at = f"{date_str} {t}"
                slot.duration_minutes = duration
                slot.active = 1
                db.merge(slot)

        db.commit()

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

# --- ПУБЛИЧНЫЕ ENDPOINTS ---
@app.get("/api/health")
def health_check():
    return {"ok": True}

@app.get("/api/site", response_model=SiteConfigPublic)
def get_site_config():
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {
        "clinic": data.get("clinic", {}), "seo": data.get("seo", {}),
        "hero": data.get("hero", {}), "legal": data.get("legal", {})
    }

@app.get("/api/services", response_model=list[ServicePublic])
def get_services(db: Session = Depends(get_db)):
    return db.query(Service).filter(Service.active == 1).order_by(Service.sort_order, Service.title).all()

@app.get("/api/slots", response_model=list[SlotPublic])
def get_slots(limit: int = 40, db: Session = Depends(get_db)):
    limit = max(1, min(limit, 120))
    today_str = datetime.now().strftime("%Y-%m-%d 00:00")
    
    slots = db.query(Slot).filter(Slot.starts_at >= today_str, Slot.active == 1).order_by(Slot.starts_at).limit(limit).all()
    booked_slots = {b.slot_id for b in db.query(Booking.slot_id).filter(Booking.status != 'cancelled').all()}
    
    result = []
    for s in slots:
        d_label, t_label = format_ru_date(s.starts_at)
        result.append(SlotPublic(
            id=s.id,
            starts_at=s.starts_at,
            available=(s.id not in booked_slots),
            dateLabel=d_label,
            timeLabel=t_label
        ))
    return result

@app.post("/api/bookings", status_code=201, response_model=AdminBookingPublic)
def create_booking(data: BookingCreate, db: Session = Depends(get_db)):
    # Проверка существования слота и услуги
    slot = db.query(Slot).filter(Slot.id == data.slotId, Slot.active == 1).first()
    service = db.query(Service).filter(Service.id == data.serviceId, Service.active == 1).first()
    
    if not slot or not service:
        raise HTTPException(status_code=400, detail="Слот или услуга не найдены")

    # Проверка занятости времени в транзакции
    taken = db.query(Booking).filter(Booking.slot_id == data.slotId, Booking.status != 'cancelled').first()
    if taken:
        raise HTTPException(status_code=409, detail="Это время уже заняли. Выберите другое окно.")

    new_booking = Booking(
        id=f"bk-{uuid.uuid4().hex[:8]}",
        slot_id=data.slotId,
        service_id=data.serviceId,
        patient_name=data.patientName,
        phone=data.phone,
        messenger=data.messenger,
        comment=data.comment,
        privacy_accepted_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        status="new",
        created_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    )
    
    db.add(new_booking)
    db.commit()
    db.refresh(new_booking)

    # Формируем красивый ответ
    d_label, t_label = format_ru_date(slot.starts_at)
    return AdminBookingPublic(
        id=new_booking.id, patient_name=new_booking.patient_name,
        phone=new_booking.phone, messenger=new_booking.messenger,
        comment=new_booking.comment, status=new_booking.status,
        created_at=new_booking.created_at,
        dateLabel=d_label, timeLabel=t_label,
        priceLabel=f"от {service.price_from} ₽", service_title=service.title
    )

# --- АДМИНСКИЕ ENDPOINTS ---
@app.get("/api/admin/bookings", response_model=list[AdminBookingPublic])
def get_admin_bookings(db: Session = Depends(get_db), token: None = Depends(verify_admin_token)):
    bookings = db.query(Booking).join(Slot).order_by(Slot.starts_at.desc()).all()
    result = []
    for b in bookings:
        d_label, t_label = format_ru_date(b.slot.starts_at)
        result.append(AdminBookingPublic(
            id=b.id, patient_name=b.patient_name, phone=b.phone,
            messenger=b.messenger, comment=b.comment, status=b.status,
            created_at=b.created_at, dateLabel=d_label, timeLabel=t_label,
            priceLabel=f"от {b.service.price_from} ₽", service_title=b.service.title
        ))
    return result

@app.patch("/api/admin/bookings/{booking_id}/status", response_model=AdminBookingPublic)
def update_booking_status(booking_id: str, data: StatusUpdate, db: Session = Depends(get_db), token: None = Depends(verify_admin_token)):
    booking = db.query(Booking).filter(Booking.id == booking_id).first()
    if not booking:
        raise HTTPException(status_code=404, detail="Бронь не найдена")
        
    booking.status = data.status
    db.commit()
    db.refresh(booking)
    
    d_label, t_label = format_ru_date(booking.slot.starts_at)
    return AdminBookingPublic(
        id=booking.id, patient_name=booking.patient_name, phone=booking.phone,
        messenger=booking.messenger, comment=booking.comment, status=booking.status,
        created_at=booking.created_at, dateLabel=d_label, timeLabel=t_label,
        priceLabel=f"от {booking.service.price_from} ₽", service_title=booking.service.title
    )

# Подключение статики
os.makedirs("static", exist_ok=True)
app.mount("/", StaticFiles(directory="static", html=True), name="static")
