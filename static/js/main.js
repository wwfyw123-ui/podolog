const ICONS = { stethoscope: "🩺", foot: "🦶", bandage: "🩹", shield: "🛡️" };
let siteData = {}, services = [], slots = [], groupedSlots = {};

async function init() {
    try {
        const [siteRes, srvRes, slotsRes] = await Promise.all([
            fetch('/api/site').then(r => r.json()),
            fetch('/api/services').then(r => r.json()),
            fetch('/api/slots?limit=60').then(r => r.json())
        ]);
        
        siteData = siteRes; services = srvRes; slots = slotsRes;
        
        renderSiteData();
        renderServices();
        groupSlots();
    } catch (e) {
        console.error("Ошибка загрузки данных", e);
        alert("Ошибка связи с сервером. Пожалуйста, обновите страницу.");
    }
}

function renderSiteData() {
    document.title = siteData.seo?.title || "Запись";
    document.getElementById('header-name').innerText = siteData.clinic?.name;
    document.getElementById('header-phone').innerText = siteData.clinic?.phone;
    document.getElementById('header-phone').href = `tel:${siteData.clinic?.phone}`;
    
    document.getElementById('hero-title').innerText = siteData.hero?.title;
    document.getElementById('hero-subtitle').innerText = siteData.hero?.subtitle;
    
    document.getElementById('footer-content').innerHTML = `
        <p><strong>${siteData.clinic?.name}</strong></p>
        <p>📞 ${siteData.clinic?.phone} | 📍 ${siteData.clinic?.address}</p>
        <p>🕒 ${siteData.clinic?.workHours}</p>
        <p style="font-size:0.8rem; margin-top:20px;">${siteData.legal?.operatorName}</p>
    `;
}

function renderServices() {
    const container = document.getElementById('services-container');
    container.innerHTML = services.map(s => `
        <div class="service-card" data-id="${s.id}">
            <h3><span style="font-size:1.5rem">${ICONS[s.icon] || "⚕️"}</span> ${s.title}</h3>
            <p class="text-muted">${s.description}</p>
            <span class="service-price">от ${new Intl.NumberFormat("ru-RU").format(s.price_from)} ₽</span>
        </div>
    `).join('');

    container.querySelectorAll('.service-card').forEach(card => {
        card.addEventListener('click', (e) => {
            document.querySelectorAll('.service-card').forEach(c => c.classList.remove('selected'));
            e.currentTarget.classList.add('selected');
            
            const srvId = e.currentTarget.dataset.id;
            const srv = services.find(x => x.id === srvId);
            document.getElementById('serviceId').value = srvId;
            document.getElementById('selected-service-text').innerHTML = `<strong>${srv.title}</strong> (от ${srv.price_from} ₽)`;
            document.getElementById('selected-service-text').style.color = 'black';
            checkFormUnlock();
        });
    });
}

function groupSlots() {
    groupedSlots = {};
    slots.filter(s => s.available).forEach(s => {
        if (!groupedSlots[s.dateLabel]) groupedSlots[s.dateLabel] = [];
        groupedSlots[s.dateLabel].push(s);
    });
    
    const daysContainer = document.getElementById('days-container');
    const dates = Object.keys(groupedSlots);
    
    if (dates.length === 0) {
        daysContainer.innerHTML = "<p>К сожалению, свободных окон нет.</p>";
        return;
    }

    daysContainer.innerHTML = dates.map(d => `<button type="button" class="day-btn" data-date="${d}">${d}</button>`).join('');
    
    daysContainer.querySelectorAll('.day-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            daysContainer.querySelectorAll('.day-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            renderTimes(e.target.dataset.date);
        });
    });
}

function renderTimes(dateLabel) {
    const container = document.getElementById('times-container');
    container.innerHTML = groupedSlots[dateLabel].map(s => 
        `<button type="button" class="time-btn" data-id="${s.id}">${s.timeLabel}</button>`
    ).join('');

    container.querySelectorAll('.time-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            container.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
            e.target.classList.add('active');
            document.getElementById('slotId').value = e.target.dataset.id;
            checkFormUnlock();
        });
    });
}

function checkFormUnlock() {
    const serviceId = document.getElementById('serviceId').value;
    const slotId = document.getElementById('slotId').value;
    const formStep = document.getElementById('personal-data');
    if (serviceId && slotId) {
        formStep.style.opacity = '1';
        formStep.style.pointerEvents = 'auto';
    }
}

document.getElementById('booking-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('submit-btn');
    const errText = document.getElementById('form-error');
    
    btn.disabled = true;
    btn.innerText = "Отправка...";
    errText.classList.add('hidden');

    const payload = {
        serviceId: document.getElementById('serviceId').value,
        slotId: document.getElementById('slotId').value,
        patientName: document.getElementById('patientName').value,
        phone: document.getElementById('phone').value,
        messenger: document.getElementById('messenger').value,
        comment: document.getElementById('comment').value,
        privacyAccepted: document.getElementById('privacyAccepted').checked
    };

    try {
        const res = await fetch('/api/bookings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        
        if (res.status === 409) {
            errText.innerText = "К сожалению, это время уже заняли. Пожалуйста, выберите другое.";
            errText.classList.remove('hidden');
            await init(); // Обновляем слоты
        } else if (!res.ok) {
            errText.innerText = "Ошибка: " + (data.detail || "Проверьте введенные данные");
            errText.classList.remove('hidden');
        } else {
            document.getElementById('booking-form').classList.add('hidden');
            document.getElementById('success-message').classList.remove('hidden');
            document.getElementById('success-details').innerHTML = `
                Пациент: ${data.patient_name}<br>
                Услуга: ${data.service_title}<br>
                Время: <b>${data.dateLabel} в ${data.timeLabel}</b>
            `;
        }
    } catch (err) {
        errText.innerText = "Ошибка сети. Попробуйте еще раз.";
        errText.classList.remove('hidden');
    } finally {
        btn.disabled = false;
        btn.innerText = "Подтвердить запись";
    }
});

init();
