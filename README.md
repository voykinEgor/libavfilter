# SmartVAD Web App (Docker)

Проект запускает 3 контейнера:

- `frontend`: UI (загрузка файла, waveform, плееры, скачивание результата)
- `backend` (Go): API, хранение исходного/обработанного файла
- `processor` (Go + FFmpeg): обработка аудио через фильтр `smartvad`

## Конфигурация через `.env`

Все критичные параметры вынесены из `docker-compose.yml` в переменные окружения.

1. Скопируйте шаблон:

```bash
cp example.env .env
```

Для PowerShell:

```powershell
Copy-Item example.env .env
```

2. При необходимости отредактируйте `.env`.

Основные параметры:

- `FRONTEND_PORT` — порт сайта на хосте
- `BACKEND_MAX_UPLOAD_MB` — лимит загрузки файла (МБ)
- `PROCESSOR_MAX_BODY_MB` — лимит тела запроса в processor (МБ)
- `BACKEND_PROCESSOR_URL` — URL processor-сервиса для backend

## Запуск

```bash
docker compose up --build
```

Сайт: [http://localhost:8080](http://localhost:8080)  
(если `FRONTEND_PORT` изменен — используйте ваш порт)

## API (backend)

- `POST /api/upload` (multipart `file`) -> `{ id, fileName, originalUrl }`
- `POST /api/process/{id}` -> `{ processedUrl, compressionRatio, originalDurationSec, processedDurationSec }`
- `GET /media/{id}/original`
- `GET /media/{id}/processed`

## Архитектура потока

1. Пользователь загружает файл в UI.
2. UI отправляет файл в `backend` (`POST /api/upload`).
3. `backend` сохраняет исходник в docker volume.
4. По команде обработки `backend` отправляет файл в `processor`.
5. `processor` запускает кастомный `ffmpeg` с `smartvad`.
6. `backend` сохраняет итог и отдает ссылку + метрики.

## Примечания

- `processor` внутри Docker собирает `libfvad` и FFmpeg `n8.1`.
- Файл фильтра: `af_smartvad.c`.
- Результат отдается в WAV для стабильного воспроизведения и скачивания в браузере.

