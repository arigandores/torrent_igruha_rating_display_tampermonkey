// ==UserScript==
// @name         iTorrents-Igruha Rating Display
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Показывает рейтинг (лайки/дизлайки) игр в углу каждой карточки
// @author       @h1pp0
// @match        https://itorrents-igruha.org/*
// @grant        GM_xmlhttpRequest
// @connect      itorrents-igruha.org
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // Стили для бейджа с рейтингом
    const style = document.createElement('style');
    style.textContent = `
        .rating-badge {
            position: absolute;
            top: 5px;
            right: 5px;
            background: rgba(0, 0, 0, 0.85);
            color: #fff;
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 12px;
            font-weight: bold;
            z-index: 100;
            display: flex;
            align-items: center;
            gap: 4px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.5);
            transition: transform 0.2s;
        }
        .rating-badge:hover {
            transform: scale(1.1);
        }
        .rating-badge.positive {
            border: 1px solid #4CAF50;
        }
        .rating-badge.negative {
            border: 1px solid #f44336;
        }
        .rating-badge.neutral {
            border: 1px solid #9e9e9e;
        }
        .rating-badge .rating-icon {
            font-size: 14px;
        }
        .rating-badge.loading {
            opacity: 0.6;
        }
        .rating-badge.loading::after {
            content: '...';
            animation: dots 1s steps(4, end) infinite;
        }
        @keyframes dots {
            0%, 20% { content: ''; }
            40% { content: '.'; }
            60% { content: '..'; }
            80%, 100% { content: '...'; }
        }
        .article-film, .short-item22, .short-item2 {
            position: relative !important;
        }
        .article-film-image, .short-img22, .short-img2 {
            position: relative !important;
        }
    `;
    document.head.appendChild(style);

    // Кэш для хранения рейтингов (используем localStorage для персистентности)
    const CACHE_KEY = 'itorrents_rating_cache';
    const CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 часа

    function loadCache() {
        try {
            const cached = localStorage.getItem(CACHE_KEY);
            if (cached) {
                const data = JSON.parse(cached);
                // Очищаем устаревшие записи
                const now = Date.now();
                for (const url in data) {
                    if (data[url].timestamp && (now - data[url].timestamp > CACHE_EXPIRY)) {
                        delete data[url];
                    }
                }
                return data;
            }
        } catch (e) {
            console.warn('[iTorrents Rating] Ошибка загрузки кэша:', e);
        }
        return {};
    }

    function saveCache(cache) {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        } catch (e) {
            console.warn('[iTorrents Rating] Ошибка сохранения кэша:', e);
        }
    }

    const ratingCache = loadCache();

    // Очередь запросов для ограничения нагрузки
    const requestQueue = [];
    let isProcessing = false;
    const DELAY_BETWEEN_REQUESTS = 300; // мс между запросами

    // Функция для парсинга рейтинга со страницы игры
    function parseRatingFromHTML(html) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Приоритетные селекторы для рейтинга на itorrents-igruha.org
        const selectors = [
            '.ratingtypeplusminus',           // Основной класс рейтинга
            '.rating-layer',                   // Слой рейтинга
            '#ratig-layer',                    // ID слоя (возможная опечатка на сайте)
            '.rating-itog',                    // Итоговый рейтинг
            '.ratingplus',                     // Положительный рейтинг
            '.ratingminus',                    // Отрицательный рейтинг
            '[id*="rating"]',                  // Любой ID с rating
            '[class*="rating"]',               // Любой класс с rating
            '.likes-count',                    // Счётчик лайков
            '.like-count'                      // Альтернативный счётчик
        ];

        for (const selector of selectors) {
            const elements = doc.querySelectorAll(selector);
            for (const el of elements) {
                const text = el.textContent.trim();
                // Ищем число со знаком + или - в начале
                const match = text.match(/([+-]\d+)/);
                if (match) {
                    return parseInt(match[1], 10);
                }
                // Или просто число
                const numMatch = text.match(/^(\d+)$/);
                if (numMatch) {
                    return parseInt(numMatch[1], 10);
                }
            }
        }

        // Ищем паттерн рейтинга в HTML напрямую
        // Формат: иконка лайка + число, например "👍 +8827" или элемент с классом и числом
        const patterns = [
            /rating[^>]*>\s*<[^>]*>\s*([+-]?\d+)/gi,
            />\s*([+-]\d{2,})\s*</g,                    // Число со знаком (минимум 2 цифры)
            /class="[^"]*plus[^"]*"[^>]*>([+-]?\d+)/gi,
            /class="[^"]*minus[^"]*"[^>]*>([+-]?\d+)/gi
        ];

        const bodyHtml = doc.body ? doc.body.innerHTML : html;

        for (const pattern of patterns) {
            const match = pattern.exec(bodyHtml);
            if (match && match[1]) {
                const num = parseInt(match[1], 10);
                if (!isNaN(num)) {
                    return num;
                }
            }
            pattern.lastIndex = 0; // Сброс индекса для глобального regex
        }

        // Поиск в span/div элементах рядом с иконками
        const containers = doc.querySelectorAll('span, div, a');
        for (const el of containers) {
            const text = el.textContent.trim();
            // Проверяем формат "+число" или "-число"
            if (/^[+-]\d+$/.test(text)) {
                return parseInt(text, 10);
            }
        }

        return null;
    }

    // Функция для получения рейтинга с помощью GM_xmlhttpRequest
    function fetchRating(url, callback) {
        if (ratingCache[url] !== undefined && ratingCache[url].rating !== undefined) {
            callback(ratingCache[url].rating);
            return;
        }

        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            timeout: 15000,
            onload: function(response) {
                if (response.status === 200) {
                    const rating = parseRatingFromHTML(response.responseText);
                    ratingCache[url] = { rating: rating, timestamp: Date.now() };
                    saveCache(ratingCache);
                    callback(rating);
                } else {
                    console.warn('[iTorrents Rating] Ошибка загрузки:', url, response.status);
                    callback(null);
                }
            },
            onerror: function(error) {
                console.warn('[iTorrents Rating] Сетевая ошибка:', url, error);
                callback(null);
            },
            ontimeout: function() {
                console.warn('[iTorrents Rating] Таймаут:', url);
                callback(null);
            }
        });
    }

    // Обработка очереди запросов
    function processQueue() {
        if (isProcessing || requestQueue.length === 0) return;

        isProcessing = true;
        const { url, callback } = requestQueue.shift();

        fetchRating(url, (rating) => {
            callback(rating);
            setTimeout(() => {
                isProcessing = false;
                processQueue();
            }, DELAY_BETWEEN_REQUESTS);
        });
    }

    // Добавление запроса в очередь
    function queueRequest(url, callback) {
        requestQueue.push({ url, callback });
        processQueue();
    }

    // Создание бейджа с рейтингом
    function createRatingBadge(rating, url) {
        const badge = document.createElement('div');
        badge.className = 'rating-badge';
        badge.title = 'Клик для обновления рейтинга';
        badge.style.cursor = 'pointer';

        if (rating === null) {
            badge.textContent = '?';
            badge.classList.add('neutral');
            badge.title = 'Рейтинг не найден. Клик для повтора';
        } else {
            const icon = rating >= 0 ? '👍' : '👎';
            const sign = rating >= 0 ? '+' : '';
            badge.innerHTML = `<span class="rating-icon">${icon}</span>${sign}${rating}`;
            badge.classList.add(rating >= 0 ? 'positive' : 'negative');
        }

        // Обработчик клика для обновления
        badge.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (!url) return;

            // Удаляем из кэша для принудительного обновления
            delete ratingCache[url];
            saveCache(ratingCache);

            // Показываем состояние загрузки
            badge.innerHTML = '<span class="rating-icon">⏳</span>';
            badge.className = 'rating-badge loading';

            // Запрашиваем заново
            fetchRating(url, (newRating) => {
                badge.classList.remove('loading');
                if (newRating === null) {
                    badge.textContent = '?';
                    badge.classList.add('neutral');
                } else {
                    const icon = newRating >= 0 ? '👍' : '👎';
                    const sign = newRating >= 0 ? '+' : '';
                    badge.innerHTML = `<span class="rating-icon">${icon}</span>${sign}${newRating}`;
                    badge.className = 'rating-badge ' + (newRating >= 0 ? 'positive' : 'negative');
                }
            });
        });

        return badge;
    }

    // Создание placeholder бейджа (загрузка)
    function createLoadingBadge() {
        const badge = document.createElement('div');
        badge.className = 'rating-badge loading';
        badge.innerHTML = '<span class="rating-icon">⏳</span>';
        return badge;
    }

    // Обработка карточек игр
    function processGameCards() {
        // Селекторы для разных типов карточек на сайте
        const cardSelectors = [
            '.article-film',           // Основные карточки игр
            '.short-item22',           // Короткие карточки (онлайн игры и т.д.)
            '.short-item2'             // Боковые карточки
        ];

        cardSelectors.forEach(selector => {
            const cards = document.querySelectorAll(selector);

            cards.forEach(card => {
                // Пропускаем если уже обработана
                if (card.querySelector('.rating-badge')) return;

                // Находим ссылку на игру
                const link = card.querySelector('a[href*=".html"]');
                if (!link) return;

                const url = link.href;

                // Пропускаем ссылки не на страницы игр
                if (!url.match(/\/\d+-/)) return;

                // Определяем куда добавить бейдж
                let container = card.querySelector('.article-film-image') ||
                               card.querySelector('.short-img22') ||
                               card.querySelector('.short-img2') ||
                               card;

                // Создаём placeholder
                const loadingBadge = createLoadingBadge();
                container.appendChild(loadingBadge);

                // Запрашиваем рейтинг
                queueRequest(url, (rating) => {
                    loadingBadge.remove();
                    const ratingBadge = createRatingBadge(rating, url);
                    container.appendChild(ratingBadge);
                });
            });
        });
    }

    // Наблюдатель за изменениями DOM (для динамически загружаемого контента)
    const observer = new MutationObserver((mutations) => {
        let shouldProcess = false;
        for (const mutation of mutations) {
            if (mutation.addedNodes.length > 0) {
                shouldProcess = true;
                break;
            }
        }
        if (shouldProcess) {
            setTimeout(processGameCards, 100);
        }
    });

    // Запуск
    function init() {
        console.log('[iTorrents Rating] Скрипт запущен');
        processGameCards();

        // Наблюдаем за изменениями для пагинации и динамической загрузки
        observer.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    // Ждём загрузку страницы
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
