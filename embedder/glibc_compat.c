/* Lets the Linux binary run on glibc 2.28 (README "glibc floor"). The static
 * onnxruntime and libstdc++ are compiled against newer glibc headers and
 * reference symbols 2.28 lacks; defining them here binds those references
 * locally instead of to a versioned libc export. */
#define _GNU_SOURCE
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <sys/syscall.h>
#include <unistd.h>

/* glibc 2.38: C23 entry points (they differ only in "0b" parsing). */
long __isoc23_strtol(const char *s, char **e, int b) { return strtol(s, e, b); }
long long __isoc23_strtoll(const char *s, char **e, int b) { return strtoll(s, e, b); }
unsigned long __isoc23_strtoul(const char *s, char **e, int b) { return strtoul(s, e, b); }
unsigned long long __isoc23_strtoull(const char *s, char **e, int b) { return strtoull(s, e, b); }
long __isoc23_wcstol(const wchar_t *s, wchar_t **e, int b) { return wcstol(s, e, b); }
long long __isoc23_wcstoll(const wchar_t *s, wchar_t **e, int b) { return wcstoll(s, e, b); }
unsigned long __isoc23_wcstoul(const wchar_t *s, wchar_t **e, int b) { return wcstoul(s, e, b); }
unsigned long long __isoc23_wcstoull(const wchar_t *s, wchar_t **e, int b) { return wcstoull(s, e, b); }
int __isoc23_vsscanf(const char *s, const char *f, va_list ap) { return vsscanf(s, f, ap); }
int __isoc23_sscanf(const char *s, const char *f, ...) {
  va_list ap;
  va_start(ap, f);
  int r = vsscanf(s, f, ap);
  va_end(ap);
  return r;
}

/* glibc 2.32. 0 = "may be multi-threaded": libstdc++ then always uses atomics. */
char __libc_single_threaded = 0;

/* glibc 2.30. */
pid_t gettid(void) { return (pid_t)syscall(SYS_gettid); }
