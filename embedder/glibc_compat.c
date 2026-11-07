/* Lets the Linux binary run on glibc 2.28 (README "glibc floor"). The static
 * onnxruntime and libstdc++ are compiled against newer glibc headers and
 * reference symbols 2.28 lacks; defining them here binds those references
 * locally instead of to a versioned libc export. */
#define _GNU_SOURCE
#include <stdlib.h>
#include <sys/syscall.h>
#include <unistd.h>

/* glibc 2.38: C23 strto* entry points (they differ only in "0b" parsing). */
long __isoc23_strtol(const char *s, char **e, int b) { return strtol(s, e, b); }
long long __isoc23_strtoll(const char *s, char **e, int b) { return strtoll(s, e, b); }
unsigned long long __isoc23_strtoull(const char *s, char **e, int b) { return strtoull(s, e, b); }

/* glibc 2.32. 0 = "may be multi-threaded": libstdc++ then always uses atomics. */
char __libc_single_threaded = 0;

/* glibc 2.30. */
pid_t gettid(void) { return (pid_t)syscall(SYS_gettid); }
