let allBookings = [];

document.addEventListener('DOMContentLoaded', () => {
    const savedToken = localStorage.getItem('admin_token');
    if (savedToken) {
        document.getElementById('admin-token').value = savedToken;
        loadBookings();
    }
});

async function loadBookings() {
    const token = document.getElementById('admin-token').value;
    if (!token) return alert("Введите пароль");

    try {
        const res = await fetch('/api/admin/bookings', {
            headers: { 'X-Admin-Token': token }
        });
        
        if (res.status === 401) {
            alert("Неверный пароль");
            localStorage.removeItem('admin_token');
            return;
        }

        allBookings = await res.json();
        localStorage.setItem('admin_token', token);
        
        document.getElementById('auth-box').classList.add('hidden');
        document.getElementById('content-area').classList.remove('hidden');
        renderTable();
    } catch (e) {
        alert("Ошибка сети");
    }
}

function renderTable() {
    const filter = document.getElementById('status-filter').value;
    const tbody = document.getElementById('bookings-tbody');
    
    const filtered = filter === 'all' ? allBookings : allBookings.filter(b => b.status === filter);

    tbody.innerHTML = filtered.map(b => `
        <tr class="${b.status === 'cancelled' ? 'status-cancelled' : ''}">
            <td data-label="Время"><b>${b.dateLabel}</b><br>${b.timeLabel}</td>
            <td data-label="Пациент">${b.patient_name}</td>
            <td data-label="Контакты">${b.phone}<br><small>${b.messenger}</small></td>
            <td data-label="Услуга">${b.service_title}<br><small>${b.priceLabel}</small></td>
            <td data-label="Коммент"><small>${b.comment || '-'}</small></td>
            <td data-label="Статус">
                <select class="status-select status-${b.status}" onchange="changeStatus('${b.id}', this.value)">
                    <option value="new" ${b.status==='new'?'selected':''}>Новая</option>
                    <option value="confirmed" ${b.status==='confirmed'?'selected':''}>Подтверждена</option>
                    <option value="done" ${b.status==='done'?'selected':''}>Выполнена</option>
                    <option value="cancelled" ${b.status==='cancelled'?'selected':''}>Отменена</option>
                </select>
            </td>
        </tr>
    `).join('');
}

async function changeStatus(id, newStatus) {
    const token = localStorage.getItem('admin_token');
    try {
        const res = await fetch(`/api/admin/bookings/${id}/status`, {
            method: 'PATCH',
            headers: { 
                'X-Admin-Token': token,
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({ status: newStatus })
        });
        if (res.ok) {
            const updated = await res.json();
            const index = allBookings.findIndex(b => b.id === id);
            allBookings[index] = updated;
            renderTable();
        } else {
            alert("Ошибка при обновлении статуса");
            loadBookings(); // Откат изменений UI
        }
    } catch (e) {
        alert("Ошибка сети");
    }
}
