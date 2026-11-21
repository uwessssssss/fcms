/*
 * simclock -- a movable clock for the simulation database server ONLY.
 *
 * Preloaded into a throwaway PostgreSQL server (tools/sim/run.sh), it adds an
 * offset, in microseconds, to every wall-clock read. The offset lives in a
 * small shared file the simulator rewrites before each step, so now(),
 * column defaults and every function see "the simulated moment" -- and the
 * real functions run unchanged, rules and all. Never load this into a server
 * that holds real data.
 *
 *   gcc -shared -fPIC -O2 -o simclock.so simclock.c -ldl
 *   SIMCLOCK_FILE=/path/offset LD_PRELOAD=./simclock.so postgres ...
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

static volatile int64_t *offset_us;   /* shared with the simulator */
static int (*real_clock_gettime)(clockid_t, struct timespec *);
static int (*real_gettimeofday)(struct timeval *, void *);

static int64_t offset(void) {
  if (!offset_us) {
    const char *f = getenv("SIMCLOCK_FILE");
    if (!f) return 0;
    int fd = open(f, O_RDONLY);
    if (fd < 0) return 0;
    void *p = mmap(NULL, sizeof(int64_t), PROT_READ, MAP_SHARED, fd, 0);
    close(fd);
    if (p == MAP_FAILED) return 0;
    offset_us = (volatile int64_t *)p;
  }
  return *offset_us;
}

int clock_gettime(clockid_t id, struct timespec *ts) {
  if (!real_clock_gettime) real_clock_gettime = dlsym(RTLD_NEXT, "clock_gettime");
  int r = real_clock_gettime(id, ts);
  if (r == 0 && (id == CLOCK_REALTIME || id == CLOCK_REALTIME_COARSE)) {
    int64_t ns = (int64_t)ts->tv_nsec + (offset() % 1000000) * 1000;
    ts->tv_sec += offset() / 1000000 + ns / 1000000000;
    ts->tv_nsec = ns % 1000000000;
    if (ts->tv_nsec < 0) { ts->tv_nsec += 1000000000; ts->tv_sec--; }
  }
  return r;
}

int gettimeofday(struct timeval *tv, void *tz) {
  if (!real_gettimeofday) real_gettimeofday = dlsym(RTLD_NEXT, "gettimeofday");
  int r = real_gettimeofday(tv, tz);
  if (r == 0 && tv) {
    int64_t us = (int64_t)tv->tv_sec * 1000000 + tv->tv_usec + offset();
    tv->tv_sec = us / 1000000; tv->tv_usec = us % 1000000;
  }
  return r;
}

time_t time(time_t *t) {
  struct timeval tv; gettimeofday(&tv, NULL);
  if (t) *t = tv.tv_sec;
  return tv.tv_sec;
}
