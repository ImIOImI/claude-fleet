/* The prebuilt static onnxruntime is compiled against glibc >= 2.38, whose
 * headers redirect strtol* to the C23 __isoc23_* entry points. Older glibc
 * lacks them; forward to the classic functions (they differ only in 0b
 * prefix parsing, which onnxruntime never relies on). */
#include <stdlib.h>
long __isoc23_strtol(const char *s, char **e, int b) { return strtol(s, e, b); }
long long __isoc23_strtoll(const char *s, char **e, int b) { return strtoll(s, e, b); }
unsigned long long __isoc23_strtoull(const char *s, char **e, int b) { return strtoull(s, e, b); }
