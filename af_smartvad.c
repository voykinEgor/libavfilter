/*
 * smartvad audio filter (stage 2 MVP)
 *
 * MVP design choice for reliability:
 *   - filter is limited to mono 16 kHz s16
 *   - VAD and output operate in the same format
 *
 * This keeps integration with libfvad straightforward and deterministic.
 */

#include <stdint.h>
#include <string.h>
#include <limits.h>

#include <fvad.h>

#include "libavutil/channel_layout.h"
#include "libavutil/common.h"
#include "libavutil/mem.h"
#include "libavutil/opt.h"

#include "audio.h"
#include "avfilter.h"
#include "filters.h"
#include "formats.h"

typedef struct SmartVADPendingWindow {
    int16_t *samples;
    int vad_speech;
} SmartVADPendingWindow;

typedef struct SmartVADContext {
    const AVClass *class;

    int frame_ms;
    int vad_mode;
    int min_silence_ms;
    int target_silence_ms;
    int speech_pad_ms;
    int fade_ms;
    int debug_log;

    Fvad *vad;

    int frame_samples;
    int pad_frames;
    int min_silence_frames;
    int target_silence_frames;
    int fade_samples;

    int16_t *in_buf;
    int in_buf_samples;
    int in_buf_alloc_samples;

    SmartVADPendingWindow *pending;
    int pending_count;
    int pending_alloc;

    uint8_t *past_vad_flags;
    int past_vad_count;

    int16_t *silence_buf;
    int silence_samples;
    int silence_alloc_samples;
    int silence_windows;

    int16_t *out_buf;
    int out_samples;
    int out_alloc_samples;

    int eof;
    int finished;
    int64_t next_out_pts;
} SmartVADContext;

#define OFFSET(x) offsetof(SmartVADContext, x)
#define A AV_OPT_FLAG_AUDIO_PARAM | AV_OPT_FLAG_FILTERING_PARAM

static const AVOption smartvad_options[] = {
    { "frame_ms",          "VAD frame size in milliseconds (10/20/30)", OFFSET(frame_ms),          AV_OPT_TYPE_INT,  { .i64 = 20 }, 10,    30, A },
    { "vad_mode",          "VAD aggressiveness mode",                    OFFSET(vad_mode),          AV_OPT_TYPE_INT,  { .i64 = 2 },  0,     3, A },
    { "min_silence_ms",    "min silence to compress",                    OFFSET(min_silence_ms),    AV_OPT_TYPE_INT,  { .i64 = 300 }, 0, 10000, A },
    { "target_silence_ms", "target silence after compression",           OFFSET(target_silence_ms), AV_OPT_TYPE_INT,  { .i64 = 120 }, 0, 10000, A },
    { "speech_pad_ms",     "speech padding before/after speech",         OFFSET(speech_pad_ms),     AV_OPT_TYPE_INT,  { .i64 = 120 }, 0,  2000, A },
    { "fade_ms",           "fade-in/out duration at glue points",        OFFSET(fade_ms),           AV_OPT_TYPE_INT,  { .i64 = 10 },  0,  2000, A },
    { "debug_log",         "enable verbose debug logging",               OFFSET(debug_log),         AV_OPT_TYPE_BOOL, { .i64 = 0 },   0,     1, A },
    { NULL }
};

AVFILTER_DEFINE_CLASS(smartvad);

static int smartvad_reserve_i16(int16_t **buf, int *alloc_samples, int need_samples)
{
    int new_alloc;
    int16_t *tmp;

    if (need_samples < 0)
        return AVERROR(EINVAL);

    if (need_samples <= *alloc_samples)
        return 0;

    new_alloc = FFMAX(need_samples, FFMAX(1024, *alloc_samples + *alloc_samples / 2));
    tmp = av_realloc_array(*buf, new_alloc, sizeof(**buf));
    if (!tmp)
        return AVERROR(ENOMEM);

    *buf = tmp;
    *alloc_samples = new_alloc;
    return 0;
}

static int smartvad_append_i16(int16_t **buf, int *size_samples, int *alloc_samples,
                               const int16_t *src, int nb_samples)
{
    int ret;

    if (nb_samples <= 0)
        return 0;

    if (*size_samples > INT_MAX - nb_samples)
        return AVERROR(EINVAL);

    ret = smartvad_reserve_i16(buf, alloc_samples, *size_samples + nb_samples);
    if (ret < 0)
        return ret;

    memcpy(*buf + *size_samples, src, (size_t)nb_samples * sizeof(**buf));
    *size_samples += nb_samples;
    return 0;
}

static int smartvad_pending_reserve(SmartVADContext *s, int need)
{
    SmartVADPendingWindow *tmp;
    int new_alloc;

    if (need <= s->pending_alloc)
        return 0;

    new_alloc = FFMAX(need, FFMAX(64, s->pending_alloc + s->pending_alloc / 2));
    tmp = av_realloc_array(s->pending, new_alloc, sizeof(*s->pending));
    if (!tmp)
        return AVERROR(ENOMEM);

    s->pending = tmp;
    s->pending_alloc = new_alloc;
    return 0;
}

static void smartvad_apply_fade_in(int16_t *samples, int nb_samples, int fade_samples)
{
    int i;

    if (fade_samples <= 0 || nb_samples <= 0)
        return;

    fade_samples = FFMIN(fade_samples, nb_samples);

    for (i = 0; i < fade_samples; i++) {
        int32_t v = samples[i];
        int32_t gain = i + 1;
        samples[i] = av_clip_int16((v * gain) / fade_samples);
    }
}

static void smartvad_apply_fade_out(int16_t *samples, int nb_samples, int fade_samples)
{
    int i;

    if (fade_samples <= 0 || nb_samples <= 0)
        return;

    fade_samples = FFMIN(fade_samples, nb_samples);

    for (i = 0; i < fade_samples; i++) {
        int idx = nb_samples - fade_samples + i;
        int32_t v = samples[idx];
        int32_t gain = fade_samples - i - 1;
        samples[idx] = av_clip_int16((v * gain) / fade_samples);
    }
}

static int smartvad_push_output_frames(AVFilterContext *ctx, int flush)
{
    SmartVADContext *s = ctx->priv;
    AVFilterLink *outlink = ctx->outputs[0];
    int ret;

    while (s->out_samples >= s->frame_samples || (flush && s->out_samples > 0)) {
        int nb = s->frame_samples;
        AVFrame *out;

        if (flush && s->out_samples < nb)
            nb = s->out_samples;

        out = ff_get_audio_buffer(outlink, nb);
        if (!out)
            return AVERROR(ENOMEM);

        memcpy(out->data[0], s->out_buf, (size_t)nb * sizeof(*s->out_buf));

        if (s->next_out_pts != AV_NOPTS_VALUE) {
            out->pts = s->next_out_pts;
            s->next_out_pts += av_rescale_q(nb,
                                            (AVRational){ 1, outlink->sample_rate },
                                            outlink->time_base);
        } else {
            out->pts = AV_NOPTS_VALUE;
        }

        s->out_samples -= nb;
        if (s->out_samples > 0) {
            memmove(s->out_buf,
                    s->out_buf + nb,
                    (size_t)s->out_samples * sizeof(*s->out_buf));
        }

        if (s->debug_log) {
            av_log(ctx, AV_LOG_INFO,
                   "smartvad output frame: nb_samples=%d out_buf_after=%d\n",
                   nb, s->out_samples);
        }

        ret = ff_filter_frame(outlink, out);
        if (ret < 0)
            return ret;
    }

    return 0;
}

static int smartvad_flush_silence_run(AVFilterContext *ctx)
{
    SmartVADContext *s = ctx->priv;
    int keep_total;
    int keep_head;
    int keep_tail;
    int drop_windows;
    int ret;

    if (s->silence_windows <= 0)
        return 0;

    if (s->silence_windows < s->min_silence_frames ||
        s->target_silence_frames >= s->silence_windows) {
        keep_total = s->silence_windows;
    } else {
        keep_total = s->target_silence_frames;
    }

    keep_total = FFMIN(keep_total, s->silence_windows);
    keep_total = FFMAX(keep_total, 0);

    keep_head = keep_total / 2;
    keep_tail = keep_total - keep_head;
    drop_windows = s->silence_windows - keep_total;

    if (s->debug_log) {
        av_log(ctx, AV_LOG_INFO,
               "smartvad silence segment: windows=%d keep=%d drop=%d\n",
               s->silence_windows, keep_total, drop_windows);
    }

    if (keep_head > 0) {
        int head_samples = keep_head * s->frame_samples;
        ret = smartvad_append_i16(&s->out_buf, &s->out_samples, &s->out_alloc_samples,
                                  s->silence_buf, head_samples);
        if (ret < 0)
            return ret;

        if (drop_windows > 0 && s->fade_samples > 0) {
            smartvad_apply_fade_out(s->out_buf + (s->out_samples - head_samples),
                                    head_samples, s->fade_samples);
        }
    }

    if (keep_tail > 0) {
        int tail_samples = keep_tail * s->frame_samples;
        int tail_start = s->out_samples;
        const int16_t *tail_src = s->silence_buf +
                                  (s->silence_windows - keep_tail) * s->frame_samples;

        ret = smartvad_append_i16(&s->out_buf, &s->out_samples, &s->out_alloc_samples,
                                  tail_src, tail_samples);
        if (ret < 0)
            return ret;

        if (drop_windows > 0 && s->fade_samples > 0) {
            smartvad_apply_fade_in(s->out_buf + tail_start,
                                   tail_samples, s->fade_samples);
        }
    }

    s->silence_windows = 0;
    s->silence_samples = 0;
    return 0;
}

static void smartvad_history_push(SmartVADContext *s, int vad_speech)
{
    if (s->pad_frames <= 0)
        return;

    if (s->past_vad_count < s->pad_frames) {
        s->past_vad_flags[s->past_vad_count++] = !!vad_speech;
        return;
    }

    if (s->pad_frames > 1) {
        memmove(s->past_vad_flags,
                s->past_vad_flags + 1,
                (size_t)(s->pad_frames - 1) * sizeof(*s->past_vad_flags));
    }
    s->past_vad_flags[s->pad_frames - 1] = !!vad_speech;
}

static int smartvad_padded_speech_for_oldest(const SmartVADContext *s, int flush)
{
    int lookahead;
    int i;

    if (s->pending_count <= 0)
        return 0;

    lookahead = flush ? (s->pending_count - 1) : s->pad_frames;
    lookahead = FFMIN(lookahead, s->pending_count - 1);

    if (s->pending[0].vad_speech)
        return 1;

    for (i = 0; i < s->past_vad_count; i++) {
        if (s->past_vad_flags[i])
            return 1;
    }

    for (i = 1; i <= lookahead; i++) {
        if (s->pending[i].vad_speech)
            return 1;
    }

    return 0;
}

static int smartvad_pending_pop_classified(SmartVADContext *s, int flush,
                                           SmartVADPendingWindow *out,
                                           int *is_padded_speech)
{
    if (s->pending_count <= 0)
        return 0;

    if (!flush && s->pending_count <= s->pad_frames)
        return 0;

    *is_padded_speech = smartvad_padded_speech_for_oldest(s, flush);

    *out = s->pending[0];
    s->pending_count--;
    if (s->pending_count > 0) {
        memmove(s->pending,
                s->pending + 1,
                (size_t)s->pending_count * sizeof(*s->pending));
    }

    smartvad_history_push(s, out->vad_speech);
    return 1;
}

static int smartvad_handle_classified_window(AVFilterContext *ctx,
                                             SmartVADPendingWindow *win,
                                             int is_padded_speech)
{
    SmartVADContext *s = ctx->priv;
    int ret;

    if (is_padded_speech) {
        ret = smartvad_flush_silence_run(ctx);
        if (ret < 0)
            return ret;

        ret = smartvad_append_i16(&s->out_buf, &s->out_samples, &s->out_alloc_samples,
                                  win->samples, s->frame_samples);
        if (ret < 0)
            return ret;
    } else {
        ret = smartvad_append_i16(&s->silence_buf, &s->silence_samples, &s->silence_alloc_samples,
                                  win->samples, s->frame_samples);
        if (ret < 0)
            return ret;
        s->silence_windows++;
    }

    return 0;
}

static int smartvad_process_pending(AVFilterContext *ctx, int flush)
{
    SmartVADContext *s = ctx->priv;
    int ret;

    while (1) {
        SmartVADPendingWindow win = { 0 };
        int padded_speech;
        int got = smartvad_pending_pop_classified(s, flush, &win, &padded_speech);

        if (!got)
            break;

        if (s->debug_log) {
            av_log(ctx, AV_LOG_INFO,
                   "smartvad window: vad=%d padded_speech=%d pending_after=%d\n",
                   win.vad_speech, padded_speech, s->pending_count);
        }

        ret = smartvad_handle_classified_window(ctx, &win, padded_speech);
        av_freep(&win.samples);
        if (ret < 0)
            return ret;
    }

    if (flush) {
        ret = smartvad_flush_silence_run(ctx);
        if (ret < 0)
            return ret;
    }

    return 0;
}

static int smartvad_analyze_input_buffer(AVFilterContext *ctx, int flush)
{
    SmartVADContext *s = ctx->priv;
    int ret;

    while (s->in_buf_samples >= s->frame_samples) {
        SmartVADPendingWindow win;
        int vad;

        win.samples = av_malloc_array(s->frame_samples, sizeof(*win.samples));
        if (!win.samples)
            return AVERROR(ENOMEM);

        memcpy(win.samples, s->in_buf, (size_t)s->frame_samples * sizeof(*s->in_buf));

        s->in_buf_samples -= s->frame_samples;
        if (s->in_buf_samples > 0) {
            memmove(s->in_buf,
                    s->in_buf + s->frame_samples,
                    (size_t)s->in_buf_samples * sizeof(*s->in_buf));
        }

        vad = fvad_process(s->vad, win.samples, s->frame_samples);
        if (vad < 0) {
            av_freep(&win.samples);
            av_log(ctx, AV_LOG_ERROR, "smartvad: fvad_process failed\n");
            return AVERROR_EXTERNAL;
        }
        win.vad_speech = !!vad;

        ret = smartvad_pending_reserve(s, s->pending_count + 1);
        if (ret < 0) {
            av_freep(&win.samples);
            return ret;
        }

        s->pending[s->pending_count++] = win;
    }

    return smartvad_process_pending(ctx, flush);
}

static int smartvad_consume_input_frame(AVFilterContext *ctx, AVFrame *in)
{
    SmartVADContext *s = ctx->priv;
    AVFilterLink *inlink = ctx->inputs[0];
    int ret;

    if (in->format != AV_SAMPLE_FMT_S16 ||
        in->ch_layout.nb_channels != 1 ||
        inlink->sample_rate != 16000) {
        av_frame_free(&in);
        return AVERROR(EINVAL);
    }

    if (s->next_out_pts == AV_NOPTS_VALUE && in->pts != AV_NOPTS_VALUE)
        s->next_out_pts = in->pts;

    if (s->debug_log) {
        av_log(ctx, AV_LOG_INFO,
               "smartvad input frame: nb_samples=%d in_buf_before=%d\n",
               in->nb_samples, s->in_buf_samples);
    }

    ret = smartvad_append_i16(&s->in_buf, &s->in_buf_samples, &s->in_buf_alloc_samples,
                              (const int16_t *)in->data[0], in->nb_samples);
    av_frame_free(&in);
    if (ret < 0)
        return ret;

    ret = smartvad_analyze_input_buffer(ctx, 0);
    if (ret < 0)
        return ret;

    return smartvad_push_output_frames(ctx, 0);
}

static av_cold int smartvad_init(AVFilterContext *ctx)
{
    SmartVADContext *s = ctx->priv;

    if (s->frame_ms != 10 && s->frame_ms != 20 && s->frame_ms != 30) {
        av_log(ctx, AV_LOG_ERROR, "smartvad: frame_ms must be 10, 20, or 30\n");
        return AVERROR(EINVAL);
    }

    s->vad = fvad_new();
    if (!s->vad)
        return AVERROR(ENOMEM);

    if (fvad_set_mode(s->vad, s->vad_mode) < 0) {
        av_log(ctx, AV_LOG_ERROR, "smartvad: invalid vad_mode=%d\n", s->vad_mode);
        fvad_free(s->vad);
        s->vad = NULL;
        return AVERROR(EINVAL);
    }

    if (fvad_set_sample_rate(s->vad, 16000) < 0) {
        av_log(ctx, AV_LOG_ERROR, "smartvad: failed to set VAD sample rate to 16000\n");
        fvad_free(s->vad);
        s->vad = NULL;
        return AVERROR(EINVAL);
    }

    s->next_out_pts = AV_NOPTS_VALUE;
    return 0;
}

static av_cold void smartvad_uninit(AVFilterContext *ctx)
{
    SmartVADContext *s = ctx->priv;
    int i;

    if (s->pending) {
        for (i = 0; i < s->pending_count; i++)
            av_freep(&s->pending[i].samples);
    }

    av_freep(&s->pending);
    av_freep(&s->past_vad_flags);
    av_freep(&s->in_buf);
    av_freep(&s->silence_buf);
    av_freep(&s->out_buf);

    if (s->vad)
        fvad_free(s->vad);
    s->vad = NULL;
}

static int smartvad_query_formats(const AVFilterContext *ctx,
                                  AVFilterFormatsConfig **cfg_in,
                                  AVFilterFormatsConfig **cfg_out)
{
    static const enum AVSampleFormat sample_fmts[] = {
        AV_SAMPLE_FMT_S16,
        AV_SAMPLE_FMT_NONE
    };
    static const AVChannelLayout chlayouts[] = {
        AV_CHANNEL_LAYOUT_MONO,
        { 0 }
    };
    int ret;

    ret = ff_set_common_formats_from_list2(ctx, cfg_in, cfg_out, sample_fmts);
    if (ret < 0)
        return ret;

    ret = ff_set_common_channel_layouts_from_list2(ctx, cfg_in, cfg_out, chlayouts);
    if (ret < 0)
        return ret;

    return 0;
}

static int smartvad_config_input(AVFilterLink *inlink)
{
    AVFilterContext *ctx = inlink->dst;
    SmartVADContext *s = ctx->priv;

    if (inlink->sample_rate != 16000)
        return AVERROR(EINVAL);

    s->frame_samples = av_rescale_rnd((int64_t)inlink->sample_rate,
                                      s->frame_ms, 1000, AV_ROUND_DOWN);
    if (s->frame_samples <= 0)
        return AVERROR(EINVAL);

    s->pad_frames = av_rescale_rnd((int64_t)s->speech_pad_ms, 1,
                                   s->frame_ms, AV_ROUND_UP);
    s->min_silence_frames = av_rescale_rnd((int64_t)s->min_silence_ms, 1,
                                           s->frame_ms, AV_ROUND_UP);
    s->target_silence_frames = av_rescale_rnd((int64_t)s->target_silence_ms, 1,
                                              s->frame_ms, AV_ROUND_DOWN);
    if (s->target_silence_ms > 0 && s->target_silence_frames == 0)
        s->target_silence_frames = 1;

    s->fade_samples = av_rescale_rnd((int64_t)inlink->sample_rate,
                                     s->fade_ms, 1000, AV_ROUND_DOWN);

    av_freep(&s->past_vad_flags);
    s->past_vad_count = 0;
    if (s->pad_frames > 0) {
        s->past_vad_flags = av_malloc_array(s->pad_frames, sizeof(*s->past_vad_flags));
        if (!s->past_vad_flags)
            return AVERROR(ENOMEM);
    }

    if (s->debug_log) {
        av_log(ctx, AV_LOG_INFO,
               "smartvad init: sr=%d frame_ms=%d frame_samples=%d pad_frames=%d min_silence_frames=%d target_silence_frames=%d fade_samples=%d\n",
               inlink->sample_rate,
               s->frame_ms,
               s->frame_samples,
               s->pad_frames,
               s->min_silence_frames,
               s->target_silence_frames,
               s->fade_samples);
    }

    return 0;
}

static int smartvad_activate(AVFilterContext *ctx)
{
    SmartVADContext *s = ctx->priv;
    AVFilterLink *inlink = ctx->inputs[0];
    AVFilterLink *outlink = ctx->outputs[0];
    AVFrame *in = NULL;
    int ret;
    int status;
    int64_t status_pts;

    FF_FILTER_FORWARD_STATUS_BACK(outlink, inlink);

    if (!s->eof) {
        ret = ff_inlink_consume_frame(inlink, &in);
        if (ret < 0)
            return ret;
        if (ret > 0)
            return smartvad_consume_input_frame(ctx, in);

        if (ff_inlink_acknowledge_status(inlink, &status, &status_pts)) {
            if (status != AVERROR_EOF) {
                ff_outlink_set_status(outlink, status, status_pts);
                return 0;
            }
            s->eof = 1;
        }
    }

    if (s->eof && !s->finished) {
        ret = smartvad_analyze_input_buffer(ctx, 1);
        if (ret < 0)
            return ret;

        if (s->in_buf_samples > 0) {
            ret = smartvad_append_i16(&s->out_buf, &s->out_samples, &s->out_alloc_samples,
                                      s->in_buf, s->in_buf_samples);
            if (ret < 0)
                return ret;
            s->in_buf_samples = 0;
        }

        ret = smartvad_push_output_frames(ctx, 1);
        if (ret < 0)
            return ret;

        s->finished = 1;
    }

    if (s->eof && s->finished) {
        ff_outlink_set_status(outlink, AVERROR_EOF, s->next_out_pts);
        return 0;
    }

    FF_FILTER_FORWARD_WANTED(outlink, inlink);
    return FFERROR_NOT_READY;
}

static const AVFilterPad smartvad_inputs[] = {
    {
        .name         = "default",
        .type         = AVMEDIA_TYPE_AUDIO,
        .config_props = smartvad_config_input,
    },
};

static const AVFilterPad smartvad_outputs[] = {
    {
        .name = "default",
        .type = AVMEDIA_TYPE_AUDIO,
    },
};

const FFFilter ff_af_smartvad = {
    .p.name         = "smartvad",
    .p.description  = NULL_IF_CONFIG_SMALL("SmartVAD pause-compression audio filter."),
    .p.priv_class   = &smartvad_class,
    .priv_size      = sizeof(SmartVADContext),
    .init           = smartvad_init,
    .uninit         = smartvad_uninit,
    .activate       = smartvad_activate,
    FILTER_INPUTS(smartvad_inputs),
    FILTER_OUTPUTS(smartvad_outputs),
    FILTER_QUERY_FUNC2(smartvad_query_formats),
};
