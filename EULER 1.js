// The sketch is auto-generated with XOD (https://xod.io).
//
// You can compile and upload it to an Arduino-compatible board with
// Arduino IDE.
//
// Rough code overview:
//
// - Configuration section
// - STL shim
// - Immutable list classes and functions
// - XOD runtime environment
// - Native node implementation
// - Program graph definition
//
// Search for comments fenced with '====' and '----' to navigate through
// the major code blocks.

#include <Arduino.h>
#include <inttypes.h>


/*=============================================================================
 *
 *
 * Configuration
 *
 *
 =============================================================================*/

// Uncomment to turn on debug of the program
//#define XOD_DEBUG

// Uncomment to trace the program runtime in the Serial Monitor
//#define XOD_DEBUG_ENABLE_TRACE


// Uncomment to make possible simulation of the program
//#define XOD_SIMULATION

#ifdef XOD_SIMULATION
#include <WasmSerial.h>
#define XOD_DEBUG_SERIAL WasmSerial
#else
#define XOD_DEBUG_SERIAL DEBUG_SERIAL
#endif

/*=============================================================================
 *
 *
 * STL shim. Provides implementation for vital std::* constructs
 *
 *
 =============================================================================*/

namespace xod {
namespace std {

template< class T > struct remove_reference      {typedef T type;};
template< class T > struct remove_reference<T&>  {typedef T type;};
template< class T > struct remove_reference<T&&> {typedef T type;};

template <class T>
typename remove_reference<T>::type&& move(T&& a) {
    return static_cast<typename remove_reference<T>::type&&>(a);
}

} // namespace std
} // namespace xod

/*=============================================================================
 *
 *
 * Basic XOD types
 *
 *
 =============================================================================*/
namespace xod {
#if __SIZEOF_FLOAT__ == 4
typedef float Number;
#else
typedef double Number;
#endif
typedef bool Logic;
typedef unsigned long TimeMs;
typedef uint8_t ErrorFlags;
} // namespace xod

/*=============================================================================
 *
 *
 * XOD-specific list/array implementations
 *
 *
 =============================================================================*/

#ifndef XOD_LIST_H
#define XOD_LIST_H

namespace xod {
namespace detail {

/*
 * Cursors are used internaly by iterators and list views. They are not exposed
 * directly to a list consumer.
 *
 * The base `Cursor` is an interface which provides the bare minimum of methods
 * to facilitate a single iteration pass.
 */
template<typename T> class Cursor {
  public:
    virtual ~Cursor() { }
    virtual bool isValid() const = 0;
    virtual bool value(T* out) const = 0;
    virtual void next() = 0;
};

template<typename T> class NilCursor : public Cursor<T> {
  public:
    virtual bool isValid() const { return false; }
    virtual bool value(T*) const { return false; }
    virtual void next() { }
};

} // namespace detail

/*
 * Iterator is an object used to iterate a list once.
 *
 * Users create new iterators by calling `someList.iterate()`.
 * Iterators are created on stack and are supposed to have a
 * short live, e.g. for a duration of `for` loop or node’s
 * `evaluate` function. Iterators can’t be copied.
 *
 * Implemented as a pimpl pattern wrapper over the cursor.
 * Once created for a cursor, an iterator owns that cursor
 * and will delete the cursor object once destroyed itself.
 */
template<typename T>
class Iterator {
  public:
    static Iterator<T> nil() {
        return Iterator<T>(new detail::NilCursor<T>());
    }

    Iterator(detail::Cursor<T>* cursor)
        : _cursor(cursor)
    { }

    ~Iterator() {
        if (_cursor)
            delete _cursor;
    }

    Iterator(const Iterator& that) = delete;
    Iterator& operator=(const Iterator& that) = delete;

    Iterator(Iterator&& it)
        : _cursor(it._cursor)
    {
        it._cursor = nullptr;
    }

    Iterator& operator=(Iterator&& it) {
        auto tmp = it._cursor;
        it._cursor = _cursor;
        _cursor = tmp;
        return *this;
    }

    operator bool() const { return _cursor->isValid(); }

    bool value(T* out) const {
        return _cursor->value(out);
    }

    T operator*() const {
        T out;
        _cursor->value(&out);
        return out;
    }

    Iterator& operator++() {
        _cursor->next();
        return *this;
    }

  private:
    detail::Cursor<T>* _cursor;
};

/*
 * An interface for a list view. A particular list view provides a new
 * kind of iteration over existing data. This way we can use list slices,
 * list concatenations, list rotations, etc without introducing new data
 * buffers. We just change the way already existing data is iterated.
 *
 * ListView is not exposed to a list user directly, it is used internally
 * by the List class. However, deriving a new ListView is necessary if you
 * make a new list/string processing node.
 */
template<typename T> class ListView {
  public:
    virtual Iterator<T> iterate() const = 0;
};

/*
 * The list as it seen by data consumers. Have a single method `iterate`
 * to create a new iterator.
 *
 * Implemented as pimpl pattern wrapper over a list view. Takes pointer
 * to a list view in constructor and expects the view will be alive for
 * the whole life time of the list.
 */
template<typename T> class List {
  public:
    constexpr List()
        : _view(nullptr)
    { }

    List(const ListView<T>* view)
        : _view(view)
    { }

    Iterator<T> iterate() const {
        return _view ? _view->iterate() : Iterator<T>::nil();
    }

    // pre 0.15.0 backward compatibility
    List* operator->() __attribute__ ((deprecated)) { return this; }
    const List* operator->() const __attribute__ ((deprecated)) { return this; }

  private:
    const ListView<T>* _view;
};

/*
 * A list view over an old good plain C array.
 *
 * Expects the array will be alive for the whole life time of the
 * view.
 */
template<typename T> class PlainListView : public ListView<T> {
  public:
    class Cursor : public detail::Cursor<T> {
      public:
        Cursor(const PlainListView* owner)
            : _owner(owner)
            , _idx(0)
        { }

        bool isValid() const override {
            return _idx < _owner->_len;
        }

        bool value(T* out) const override {
            if (!isValid())
                return false;
            *out = _owner->_data[_idx];
            return true;
        }

        void next() override { ++_idx; }

      private:
        const PlainListView* _owner;
        size_t _idx;
    };

  public:
    PlainListView(const T* data, size_t len)
        : _data(data)
        , _len(len)
    { }

    virtual Iterator<T> iterate() const override {
        return Iterator<T>(new Cursor(this));
    }

  private:
    friend class Cursor;
    const T* _data;
    size_t _len;
};

/*
 * A list view over a null-terminated C-String.
 *
 * Expects the char buffer will be alive for the whole life time of the view.
 * You can use string literals as a buffer, since they are persistent for
 * the program execution time.
 */
class CStringView : public ListView<char> {
  public:
    class Cursor : public detail::Cursor<char> {
      public:
        Cursor(const char* str)
            : _ptr(str)
        { }

        bool isValid() const override {
            return (bool)*_ptr;
        }

        bool value(char* out) const override {
            *out = *_ptr;
            return (bool)*_ptr;
        }

        void next() override { ++_ptr; }

      private:
        const char* _ptr;
    };

  public:
    CStringView(const char* str = nullptr)
        : _str(str)
    { }

    CStringView& operator=(const CStringView& rhs) {
        _str = rhs._str;
        return *this;
    }

    virtual Iterator<char> iterate() const override {
        return _str ? Iterator<char>(new Cursor(_str)) : Iterator<char>::nil();
    }

  private:
    friend class Cursor;
    const char* _str;
};

/*
 * A list view over two other lists (Left and Right) which first iterates the
 * left one, and when exhausted, iterates the right one.
 *
 * Expects both Left and Right to be alive for the whole view life time.
 */
template<typename T> class ConcatListView : public ListView<T> {
  public:
    class Cursor : public detail::Cursor<T> {
      public:
        Cursor(Iterator<T>&& left, Iterator<T>&& right)
            : _left(std::move(left))
            , _right(std::move(right))
        { }

        bool isValid() const override {
            return _left || _right;
        }

        bool value(T* out) const override {
            return _left.value(out) || _right.value(out);
        }

        void next() override {
            _left ? ++_left : ++_right;
        }

      private:
        Iterator<T> _left;
        Iterator<T> _right;
    };

  public:
    ConcatListView() { }

    ConcatListView(List<T> left, List<T> right)
        : _left(left)
        , _right(right)
    { }

    ConcatListView& operator=(const ConcatListView& rhs) {
        _left = rhs._left;
        _right = rhs._right;
        return *this;
    }

    virtual Iterator<T> iterate() const override {
        return Iterator<T>(new Cursor(_left.iterate(), _right.iterate()));
    }

  private:
    friend class Cursor;
    List<T> _left;
    List<T> _right;
};

//----------------------------------------------------------------------------
// Text string helpers
//----------------------------------------------------------------------------

using XString = List<char>;

/*
 * List and list view in a single pack. An utility used to define constant
 * string literals in XOD.
 */
class XStringCString : public XString {
  public:
    XStringCString(const char* str)
        : XString(&_view)
        , _view(str)
    { }

  private:
    CStringView _view;
};

} // namespace xod

#endif

/*=============================================================================
 *
 *
 * Functions to work with memory
 *
 *
 =============================================================================*/

// Define the placement new operator for cores that do not provide their own.
// Note, this definition takes precedence over the existing one (if any). We found no C++ way
// to use the existing implementation _and_ this implementation if not yet defined.
template<typename T>
void* operator new(size_t, T* ptr) noexcept {
    return ptr;
}

/*=============================================================================
 *
 *
 * UART Classes, that wraps Serials
 *
 *
 =============================================================================*/

class HardwareSerial;
class SoftwareSerial;

namespace xod {

class Uart {
  private:
    long _baud;

  protected:
    bool _started = false;

  public:
    Uart(long baud) {
        _baud = baud;
    }

    virtual void begin() = 0;

    virtual void end() = 0;

    virtual void flush() = 0;

    virtual bool available() = 0;

    virtual bool writeByte(uint8_t) = 0;

    virtual bool readByte(uint8_t*) = 0;

    virtual SoftwareSerial* toSoftwareSerial() {
      return nullptr;
    }

    virtual HardwareSerial* toHardwareSerial() {
      return nullptr;
    }

    void changeBaudRate(long baud) {
      _baud = baud;
      if (_started) {
        end();
        begin();
      }
    }

    long getBaudRate() const {
      return _baud;
    }

    Stream* toStream() {
      Stream* stream = (Stream*) toHardwareSerial();
      if (stream) return stream;
      return (Stream*) toSoftwareSerial();
    }
};

class HardwareUart : public Uart {
  private:
    HardwareSerial* _serial;

  public:
    HardwareUart(HardwareSerial& hserial, uint32_t baud = 115200) : Uart(baud) {
      _serial = &hserial;
    }

    void begin();
    void end();
    void flush();

    bool available() {
      return (bool) _serial->available();
    }

    bool writeByte(uint8_t byte) {
      return (bool) _serial->write(byte);
    }

    bool readByte(uint8_t* out) {
      int data = _serial->read();
      if (data == -1) return false;
      *out = data;
      return true;
    }

    HardwareSerial* toHardwareSerial() {
      return _serial;
    }
};

void HardwareUart::begin() {
  _started = true;
  _serial->begin(getBaudRate());
};
void HardwareUart::end() {
  _started = false;
  _serial->end();
};
void HardwareUart::flush() {
  _serial->flush();
};

} // namespace xod

/*=============================================================================
 *
 *
 * Basic algorithms for XOD lists
 *
 *
 =============================================================================*/

#ifndef XOD_LIST_FUNCS_H
#define XOD_LIST_FUNCS_H



namespace xod {

/*
 * Folds a list from left. Also known as "reduce".
 */
template<typename T, typename TR>
TR foldl(List<T> xs, TR (*func)(TR, T), TR acc) {
    for (auto it = xs.iterate(); it; ++it)
        acc = func(acc, *it);
    return acc;
}

template<typename T> size_t lengthReducer(size_t len, T) {
    return len + 1;
}

/*
 * Computes length of a list.
 */
template<typename T> size_t length(List<T> xs) {
    return foldl(xs, lengthReducer<T>, (size_t)0);
}

template<typename T> T* dumpReducer(T* buff, T x) {
    *buff = x;
    return buff + 1;
}

/*
 * Copies a list content into a memory buffer.
 *
 * It is expected that `outBuff` has enough size to fit all the data.
 */
template<typename T> size_t dump(List<T> xs, T* outBuff) {
    T* buffEnd = foldl(xs, dumpReducer, outBuff);
    return buffEnd - outBuff;
}

/*
 * Compares two lists.
 */
template<typename T> bool equal(List<T> lhs, List<T> rhs) {
    auto lhsIt = lhs.iterate();
    auto rhsIt = rhs.iterate();

    for (; lhsIt && rhsIt; ++lhsIt, ++rhsIt) {
        if (*lhsIt != *rhsIt) return false;
    }

    return !lhsIt && !rhsIt;
}

template<typename T> bool operator == (List<T> lhs, List<T> rhs) {
  return equal(lhs, rhs);
}

} // namespace xod

#endif

/*=============================================================================
 *
 *
 * Format Numbers
 *
 *
 =============================================================================*/

/**
 * Provide `formatNumber` cross-platform number to string converter function.
 *
 * Taken from here:
 * https://github.com/client9/stringencoders/blob/master/src/modp_numtoa.c
 * Original function name: `modp_dtoa2`.
 *
 * Modified:
 * - `isnan` instead of tricky comparing and return "NaN"
 * - handle Infinity values and return "Inf" or "-Inf"
 * - return `OVF` and `-OVF` for numbers bigger than max possible, instead of using `sprintf`
 * - use `Number` instead of double
 * - if negative number rounds to zero, return just "0" instead of "-0"
 *
 * This is a replacement of `dtostrf`.
 */

#ifndef XOD_FORMAT_NUMBER_H
#define XOD_FORMAT_NUMBER_H

namespace xod {

/**
 * Powers of 10
 * 10^0 to 10^9
 */
static const Number powers_of_10[] = { 1, 10, 100, 1000, 10000, 100000, 1000000,
    10000000, 100000000, 1000000000 };

static void strreverse(char* begin, char* end) {
    char aux;
    while (end > begin)
        aux = *end, *end-- = *begin, *begin++ = aux;
};

size_t formatNumber(Number value, int prec, char* str) {
    if (isnan(value)) {
        strcpy(str, "NaN");
        return (size_t)3;
    }

    if (isinf(value)) {
        bool isNegative = value < 0;
        strcpy(str, isNegative ? "-Inf" : "Inf");
        return (size_t)isNegative ? 4 : 3;
    }

    /* if input is larger than thres_max return "OVF" */
    const Number thres_max = (Number)(0x7FFFFFFF);

    Number diff = 0.0;
    char* wstr = str;

    if (prec < 0) {
        prec = 0;
    } else if (prec > 9) {
        /* precision of >= 10 can lead to overflow errors */
        prec = 9;
    }

    /* we'll work in positive values and deal with the
	   negative sign issue later */
    int neg = 0;
    if (value < 0) {
        neg = 1;
        value = -value;
    }

    uint32_t whole = (uint32_t)value;
    Number tmp = (value - whole) * powers_of_10[prec];
    uint32_t frac = (uint32_t)(tmp);
    diff = tmp - frac;

    if (diff > 0.5) {
        ++frac;
        /* handle rollover, e.g.  case 0.99 with prec 1 is 1.0  */
        if (frac >= powers_of_10[prec]) {
            frac = 0;
            ++whole;
        }
    } else if (diff == 0.5 && prec > 0 && (frac & 1)) {
        /* if halfway, round up if odd, OR
		   if last digit is 0.  That last part is strange */
        ++frac;
        if (frac >= powers_of_10[prec]) {
            frac = 0;
            ++whole;
        }
    } else if (diff == 0.5 && prec == 0 && (whole & 1)) {
        ++frac;
        if (frac >= powers_of_10[prec]) {
            frac = 0;
            ++whole;
        }
    }

    if (value > thres_max) {
        if (neg) {
            strcpy(str, "-OVF");
            return (size_t)4;
        }
        strcpy(str, "OVF");
        return (size_t)3;
    }

    int has_decimal = 0;
    int count = prec;
    bool notzero = frac > 0;

    while (count > 0) {
        --count;
        *wstr++ = (char)(48 + (frac % 10));
        frac /= 10;
        has_decimal = 1;
    }

    if (frac > 0) {
        ++whole;
    }

    /* add decimal */
    if (has_decimal) {
        *wstr++ = '.';
    }

    notzero = notzero || whole > 0;

    /* do whole part
	 * Take care of sign conversion
	 * Number is reversed.
	 */
    do
        *wstr++ = (char)(48 + (whole % 10));
    while (whole /= 10);

    if (neg && notzero) {
        *wstr++ = '-';
    }
    *wstr = '\0';
    strreverse(str, wstr - 1);
    return (size_t)(wstr - str);
}

} // namespace xod
#endif


/*=============================================================================
 *
 *
 * Runtime
 *
 *
 =============================================================================*/

//----------------------------------------------------------------------------
// Debug routines
//----------------------------------------------------------------------------
// #ifndef DEBUG_SERIAL
#if defined(XOD_DEBUG) && !defined(DEBUG_SERIAL)
#  define DEBUG_SERIAL Serial
#endif

#if defined(XOD_DEBUG) && defined(XOD_DEBUG_ENABLE_TRACE)
#  define XOD_TRACE(x)      { DEBUG_SERIAL.print(x); DEBUG_SERIAL.flush(); }
#  define XOD_TRACE_LN(x)   { DEBUG_SERIAL.println(x); DEBUG_SERIAL.flush(); }
#  define XOD_TRACE_F(x)    XOD_TRACE(F(x))
#  define XOD_TRACE_FLN(x)  XOD_TRACE_LN(F(x))
#else
#  define XOD_TRACE(x)
#  define XOD_TRACE_LN(x)
#  define XOD_TRACE_F(x)
#  define XOD_TRACE_FLN(x)
#endif

//----------------------------------------------------------------------------
// PGM space utilities
//----------------------------------------------------------------------------
#define pgm_read_nodeid(address) (pgm_read_word(address))

/*
 * Workaround for bugs:
 * https://github.com/arduino/ArduinoCore-sam/pull/43
 * https://github.com/arduino/ArduinoCore-samd/pull/253
 * Remove after the PRs merge
 */
#if !defined(ARDUINO_ARCH_AVR) && defined(pgm_read_ptr)
#  undef pgm_read_ptr
#  define pgm_read_ptr(addr) (*(const void **)(addr))
#endif

namespace xod {
//----------------------------------------------------------------------------
// Global variables
//----------------------------------------------------------------------------

TimeMs g_transactionTime;
bool g_isSettingUp;
bool g_isEarlyDeferPass;

//----------------------------------------------------------------------------
// Metaprogramming utilities
//----------------------------------------------------------------------------

template<typename T> struct always_false {
    enum { value = 0 };
};

//----------------------------------------------------------------------------
// Forward declarations
//----------------------------------------------------------------------------

TimeMs transactionTime();
void runTransaction();

//----------------------------------------------------------------------------
// Engine (private API)
//----------------------------------------------------------------------------

namespace detail {

template<typename NodeT>
bool isTimedOut(const NodeT* node) {
    TimeMs t = node->timeoutAt;
    // TODO: deal with uint32 overflow
    return t && t < transactionTime();
}

template<typename NodeT>
void clearTimeout(NodeT* node) {
    node->timeoutAt = 0;
}

template<typename NodeT>
void clearStaleTimeout(NodeT* node) {
    if (isTimedOut(node))
        clearTimeout(node);
}

void printErrorToDebugSerial(uint16_t nodeId, ErrorFlags errorFlags) {
#if defined(XOD_DEBUG) || defined(XOD_SIMULATION)
    XOD_DEBUG_SERIAL.print(F("+XOD_ERR:"));
    XOD_DEBUG_SERIAL.print(g_transactionTime);
    XOD_DEBUG_SERIAL.print(':');
    XOD_DEBUG_SERIAL.print(nodeId);
    XOD_DEBUG_SERIAL.print(':');
    XOD_DEBUG_SERIAL.print(errorFlags, DEC);
    XOD_DEBUG_SERIAL.print('\r');
    XOD_DEBUG_SERIAL.print('\n');
#endif
}

} // namespace detail

//----------------------------------------------------------------------------
// Public API (can be used by native nodes’ `evaluate` functions)
//----------------------------------------------------------------------------

TimeMs transactionTime() {
    return g_transactionTime;
}

bool isSettingUp() {
    return g_isSettingUp;
}

bool isEarlyDeferPass() {
    return g_isEarlyDeferPass;
}

template<typename ContextT>
void setTimeout(ContextT* ctx, TimeMs timeout) {
    ctx->_node->timeoutAt = transactionTime() + timeout;
}

template<typename ContextT>
void clearTimeout(ContextT* ctx) {
    detail::clearTimeout(ctx->_node);
}

template<typename ContextT>
bool isTimedOut(const ContextT* ctx) {
    return detail::isTimedOut(ctx->_node);
}

bool isValidDigitalPort(uint8_t port) {
#if defined(__AVR__) && defined(NUM_DIGITAL_PINS)
    return port < NUM_DIGITAL_PINS;
#else
    return true;
#endif
}

bool isValidAnalogPort(uint8_t port) {
#if defined(__AVR__) && defined(NUM_ANALOG_INPUTS)
    return port >= A0 && port < A0 + NUM_ANALOG_INPUTS;
#else
    return true;
#endif
}

} // namespace xod

//----------------------------------------------------------------------------
// Entry point
//----------------------------------------------------------------------------
void setup() {
    // FIXME: looks like there is a rounding bug. Waiting for 100ms fights it
    delay(100);

#if defined(XOD_DEBUG) || defined(XOD_SIMULATION)
    XOD_DEBUG_SERIAL.begin(115200);
    XOD_DEBUG_SERIAL.setTimeout(10);
#endif
    XOD_TRACE_FLN("\n\nProgram started");

    xod::g_isSettingUp = true;
    xod::runTransaction();
    xod::g_isSettingUp = false;
}

void loop() {
    xod::runTransaction();
}

/*=============================================================================
 *
 *
 * Native node implementations
 *
 *
 =============================================================================*/

namespace xod {

//-----------------------------------------------------------------------------
// xod/debug/tweak-number implementation
//-----------------------------------------------------------------------------
namespace xod__debug__tweak_number {

struct State {
};

struct Node {
    Number output_OUT;
    State state;
};

struct output_OUT { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<output_OUT> { using T = Number; };

struct ContextObject {
    Node* _node;

    bool _isOutputDirty_OUT : 1;
};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            "" \
            " output_OUT");
}

template<> Number getValue<output_OUT>(Context ctx) {
    return ctx->_node->output_OUT;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            "");
    return false;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_OUT");
}

template<> void emitValue<output_OUT>(Context ctx, Number val) {
    ctx->_node->output_OUT = val;
    ctx->_isOutputDirty_OUT = true;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

void evaluate(Context ctx) {
    // The actual code that makes tweak-nodes work
    // is injected in detail::handleTweaks
}

} // namespace xod__debug__tweak_number

//-----------------------------------------------------------------------------
// xod/debug/tweak-pulse implementation
//-----------------------------------------------------------------------------
namespace xod__debug__tweak_pulse {

struct State {
};

struct Node {
    Logic output_OUT;
    State state;
};

struct output_OUT { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<output_OUT> { using T = Logic; };

struct ContextObject {
    Node* _node;

    bool _isOutputDirty_OUT : 1;
};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            "" \
            " output_OUT");
}

template<> Logic getValue<output_OUT>(Context ctx) {
    return ctx->_node->output_OUT;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            "");
    return false;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_OUT");
}

template<> void emitValue<output_OUT>(Context ctx, Logic val) {
    ctx->_node->output_OUT = val;
    ctx->_isOutputDirty_OUT = true;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

void evaluate(Context ctx) {
    // The actual code that makes tweak-nodes work
    // is injected in detail::handleTweaks
}

} // namespace xod__debug__tweak_pulse

//-----------------------------------------------------------------------------
// xod/core/clock implementation
//-----------------------------------------------------------------------------
namespace xod__core__clock {

struct State {
  TimeMs nextTrig;
};

struct Node {
    TimeMs timeoutAt;
    Logic output_TICK;
    State state;
};

struct input_EN { };
struct input_IVAL { };
struct input_RST { };
struct output_TICK { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<input_EN> { using T = Logic; };
template<> struct ValueType<input_IVAL> { using T = Number; };
template<> struct ValueType<input_RST> { using T = Logic; };
template<> struct ValueType<output_TICK> { using T = Logic; };

struct ContextObject {
    Node* _node;

    Logic _input_EN;
    Number _input_IVAL;
    Logic _input_RST;

    bool _isInputDirty_EN;
    bool _isInputDirty_RST;

    bool _isOutputDirty_TICK : 1;
};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            " input_EN input_IVAL input_RST" \
            " output_TICK");
}

template<> Logic getValue<input_EN>(Context ctx) {
    return ctx->_input_EN;
}
template<> Number getValue<input_IVAL>(Context ctx) {
    return ctx->_input_IVAL;
}
template<> Logic getValue<input_RST>(Context ctx) {
    return ctx->_input_RST;
}
template<> Logic getValue<output_TICK>(Context ctx) {
    return ctx->_node->output_TICK;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            " input_EN input_RST");
    return false;
}

template<> bool isInputDirty<input_EN>(Context ctx) {
    return ctx->_isInputDirty_EN;
}
template<> bool isInputDirty<input_RST>(Context ctx) {
    return ctx->_isInputDirty_RST;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_TICK");
}

template<> void emitValue<output_TICK>(Context ctx, Logic val) {
    ctx->_node->output_TICK = val;
    ctx->_isOutputDirty_TICK = true;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

void evaluate(Context ctx) {
    State* state = getState(ctx);
    TimeMs tNow = transactionTime();
    auto ival = getValue<input_IVAL>(ctx);
    if (ival < 0) ival = 0;
    TimeMs dt = ival * 1000;
    TimeMs tNext = tNow + dt;

    auto isEnabled = getValue<input_EN>(ctx);
    auto isRstDirty = isInputDirty<input_RST>(ctx);

    if (isTimedOut(ctx) && isEnabled && !isRstDirty) {
        emitValue<output_TICK>(ctx, 1);
        state->nextTrig = tNext;
        setTimeout(ctx, dt);
    }

    if (isRstDirty || isInputDirty<input_EN>(ctx)) {
        // Handle enable/disable/reset
        if (!isEnabled) {
            // Disable timeout loop on explicit false on EN
            state->nextTrig = 0;
            clearTimeout(ctx);
        } else if (state->nextTrig < tNow || state->nextTrig > tNext) {
            // Start timeout from scratch
            state->nextTrig = tNext;
            setTimeout(ctx, dt);
        }
    }
}

} // namespace xod__core__clock

//-----------------------------------------------------------------------------
// xod/core/flip-flop implementation
//-----------------------------------------------------------------------------
namespace xod__core__flip_flop {

struct State {
};

struct Node {
    Logic output_MEM;
    State state;
};

struct input_SET { };
struct input_TGL { };
struct input_RST { };
struct output_MEM { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<input_SET> { using T = Logic; };
template<> struct ValueType<input_TGL> { using T = Logic; };
template<> struct ValueType<input_RST> { using T = Logic; };
template<> struct ValueType<output_MEM> { using T = Logic; };

struct ContextObject {
    Node* _node;

    Logic _input_SET;
    Logic _input_TGL;
    Logic _input_RST;

    bool _isInputDirty_SET;
    bool _isInputDirty_TGL;
    bool _isInputDirty_RST;

    bool _isOutputDirty_MEM : 1;
};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            " input_SET input_TGL input_RST" \
            " output_MEM");
}

template<> Logic getValue<input_SET>(Context ctx) {
    return ctx->_input_SET;
}
template<> Logic getValue<input_TGL>(Context ctx) {
    return ctx->_input_TGL;
}
template<> Logic getValue<input_RST>(Context ctx) {
    return ctx->_input_RST;
}
template<> Logic getValue<output_MEM>(Context ctx) {
    return ctx->_node->output_MEM;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            " input_SET input_TGL input_RST");
    return false;
}

template<> bool isInputDirty<input_SET>(Context ctx) {
    return ctx->_isInputDirty_SET;
}
template<> bool isInputDirty<input_TGL>(Context ctx) {
    return ctx->_isInputDirty_TGL;
}
template<> bool isInputDirty<input_RST>(Context ctx) {
    return ctx->_isInputDirty_RST;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_MEM");
}

template<> void emitValue<output_MEM>(Context ctx, Logic val) {
    ctx->_node->output_MEM = val;
    ctx->_isOutputDirty_MEM = true;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

void evaluate(Context ctx) {
    bool oldState = getValue<output_MEM>(ctx);
    bool newState = oldState;

    if (isInputDirty<input_RST>(ctx)) {
        newState = false;
    } else if (isInputDirty<input_SET>(ctx)) {
        newState = true;
    } else if (isInputDirty<input_TGL>(ctx)) {
        newState = !oldState;
    }

    if (newState == oldState)
        return;

    emitValue<output_MEM>(ctx, newState);
}

} // namespace xod__core__flip_flop

//-----------------------------------------------------------------------------
// xod/core/not implementation
//-----------------------------------------------------------------------------
namespace xod__core__not {

//#pragma XOD dirtieness disable

struct State {
};

struct Node {
    Logic output_OUT;
    State state;
};

struct input_IN { };
struct output_OUT { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<input_IN> { using T = Logic; };
template<> struct ValueType<output_OUT> { using T = Logic; };

struct ContextObject {
    Node* _node;

    Logic _input_IN;

};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            " input_IN" \
            " output_OUT");
}

template<> Logic getValue<input_IN>(Context ctx) {
    return ctx->_input_IN;
}
template<> Logic getValue<output_OUT>(Context ctx) {
    return ctx->_node->output_OUT;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            "");
    return false;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_OUT");
}

template<> void emitValue<output_OUT>(Context ctx, Logic val) {
    ctx->_node->output_OUT = val;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

void evaluate(Context ctx) {
    auto x = getValue<input_IN>(ctx);
    emitValue<output_OUT>(ctx, !x);
}

} // namespace xod__core__not

//-----------------------------------------------------------------------------
// xod/core/pulse-on-true implementation
//-----------------------------------------------------------------------------
namespace xod__core__pulse_on_true {

struct State {
  bool state = false;
};

struct Node {
    Logic output_OUT;
    State state;
};

struct input_IN { };
struct output_OUT { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<input_IN> { using T = Logic; };
template<> struct ValueType<output_OUT> { using T = Logic; };

struct ContextObject {
    Node* _node;

    Logic _input_IN;

    bool _isOutputDirty_OUT : 1;
};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            " input_IN" \
            " output_OUT");
}

template<> Logic getValue<input_IN>(Context ctx) {
    return ctx->_input_IN;
}
template<> Logic getValue<output_OUT>(Context ctx) {
    return ctx->_node->output_OUT;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            "");
    return false;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_OUT");
}

template<> void emitValue<output_OUT>(Context ctx, Logic val) {
    ctx->_node->output_OUT = val;
    ctx->_isOutputDirty_OUT = true;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

void evaluate(Context ctx) {
    State* state = getState(ctx);
    auto newValue = getValue<input_IN>(ctx);

    if (!isSettingUp() && newValue == true && state->state == false)
        emitValue<output_OUT>(ctx, 1);

    state->state = newValue;
}

} // namespace xod__core__pulse_on_true

//-----------------------------------------------------------------------------
// xod/core/cast-to-pulse(boolean) implementation
//-----------------------------------------------------------------------------
namespace xod__core__cast_to_pulse__boolean {

struct State {
  bool state = false;
};

struct Node {
    Logic output_OUT;
    State state;
};

struct input_IN { };
struct output_OUT { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<input_IN> { using T = Logic; };
template<> struct ValueType<output_OUT> { using T = Logic; };

struct ContextObject {
    Node* _node;

    Logic _input_IN;

    bool _isOutputDirty_OUT : 1;
};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            " input_IN" \
            " output_OUT");
}

template<> Logic getValue<input_IN>(Context ctx) {
    return ctx->_input_IN;
}
template<> Logic getValue<output_OUT>(Context ctx) {
    return ctx->_node->output_OUT;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            "");
    return false;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_OUT");
}

template<> void emitValue<output_OUT>(Context ctx, Logic val) {
    ctx->_node->output_OUT = val;
    ctx->_isOutputDirty_OUT = true;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

void evaluate(Context ctx) {
    State* state = getState(ctx);
    auto newValue = getValue<input_IN>(ctx);

    if (newValue == true && state->state == false)
        emitValue<output_OUT>(ctx, 1);

    state->state = newValue;
}

} // namespace xod__core__cast_to_pulse__boolean

//-----------------------------------------------------------------------------
// xod/core/count implementation
//-----------------------------------------------------------------------------
namespace xod__core__count {

struct State {
};

struct Node {
    Number output_OUT;
    State state;
};

struct input_STEP { };
struct input_INC { };
struct input_RST { };
struct output_OUT { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<input_STEP> { using T = Number; };
template<> struct ValueType<input_INC> { using T = Logic; };
template<> struct ValueType<input_RST> { using T = Logic; };
template<> struct ValueType<output_OUT> { using T = Number; };

struct ContextObject {
    Node* _node;

    Number _input_STEP;
    Logic _input_INC;
    Logic _input_RST;

    bool _isInputDirty_INC;
    bool _isInputDirty_RST;

    bool _isOutputDirty_OUT : 1;
};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            " input_STEP input_INC input_RST" \
            " output_OUT");
}

template<> Number getValue<input_STEP>(Context ctx) {
    return ctx->_input_STEP;
}
template<> Logic getValue<input_INC>(Context ctx) {
    return ctx->_input_INC;
}
template<> Logic getValue<input_RST>(Context ctx) {
    return ctx->_input_RST;
}
template<> Number getValue<output_OUT>(Context ctx) {
    return ctx->_node->output_OUT;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            " input_INC input_RST");
    return false;
}

template<> bool isInputDirty<input_INC>(Context ctx) {
    return ctx->_isInputDirty_INC;
}
template<> bool isInputDirty<input_RST>(Context ctx) {
    return ctx->_isInputDirty_RST;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_OUT");
}

template<> void emitValue<output_OUT>(Context ctx, Number val) {
    ctx->_node->output_OUT = val;
    ctx->_isOutputDirty_OUT = true;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

void evaluate(Context ctx) {
    Number count = getValue<output_OUT>(ctx);

    if (isInputDirty<input_RST>(ctx))
        count = 0;
    else if (isInputDirty<input_INC>(ctx))
        count += getValue<input_STEP>(ctx);

    emitValue<output_OUT>(ctx, count);
}

} // namespace xod__core__count

//-----------------------------------------------------------------------------
// xod/core/any implementation
//-----------------------------------------------------------------------------
namespace xod__core__any {

struct State {
};

struct Node {
    Logic output_OUT;
    State state;
};

struct input_IN1 { };
struct input_IN2 { };
struct output_OUT { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<input_IN1> { using T = Logic; };
template<> struct ValueType<input_IN2> { using T = Logic; };
template<> struct ValueType<output_OUT> { using T = Logic; };

struct ContextObject {
    Node* _node;

    Logic _input_IN1;
    Logic _input_IN2;

    bool _isInputDirty_IN1;
    bool _isInputDirty_IN2;

    bool _isOutputDirty_OUT : 1;
};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            " input_IN1 input_IN2" \
            " output_OUT");
}

template<> Logic getValue<input_IN1>(Context ctx) {
    return ctx->_input_IN1;
}
template<> Logic getValue<input_IN2>(Context ctx) {
    return ctx->_input_IN2;
}
template<> Logic getValue<output_OUT>(Context ctx) {
    return ctx->_node->output_OUT;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            " input_IN1 input_IN2");
    return false;
}

template<> bool isInputDirty<input_IN1>(Context ctx) {
    return ctx->_isInputDirty_IN1;
}
template<> bool isInputDirty<input_IN2>(Context ctx) {
    return ctx->_isInputDirty_IN2;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_OUT");
}

template<> void emitValue<output_OUT>(Context ctx, Logic val) {
    ctx->_node->output_OUT = val;
    ctx->_isOutputDirty_OUT = true;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

void evaluate(Context ctx) {
    bool p1 = isInputDirty<input_IN1>(ctx);
    bool p2 = isInputDirty<input_IN2>(ctx);
    if (p1 || p2)
        emitValue<output_OUT>(ctx, true);
}

} // namespace xod__core__any

//-----------------------------------------------------------------------------
// xod/core/multiply implementation
//-----------------------------------------------------------------------------
namespace xod__core__multiply {

//#pragma XOD dirtieness disable

struct State {
};

struct Node {
    Number output_OUT;
    State state;
};

struct input_IN1 { };
struct input_IN2 { };
struct output_OUT { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<input_IN1> { using T = Number; };
template<> struct ValueType<input_IN2> { using T = Number; };
template<> struct ValueType<output_OUT> { using T = Number; };

struct ContextObject {
    Node* _node;

    Number _input_IN1;
    Number _input_IN2;

};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            " input_IN1 input_IN2" \
            " output_OUT");
}

template<> Number getValue<input_IN1>(Context ctx) {
    return ctx->_input_IN1;
}
template<> Number getValue<input_IN2>(Context ctx) {
    return ctx->_input_IN2;
}
template<> Number getValue<output_OUT>(Context ctx) {
    return ctx->_node->output_OUT;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            "");
    return false;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_OUT");
}

template<> void emitValue<output_OUT>(Context ctx, Number val) {
    ctx->_node->output_OUT = val;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

void evaluate(Context ctx) {
    auto x = getValue<input_IN1>(ctx);
    auto y = getValue<input_IN2>(ctx);
    emitValue<output_OUT>(ctx, x * y);
}

} // namespace xod__core__multiply

//-----------------------------------------------------------------------------
// xod/core/add implementation
//-----------------------------------------------------------------------------
namespace xod__core__add {

//#pragma XOD dirtieness disable

struct State {
};

struct Node {
    Number output_OUT;
    State state;
};

struct input_IN1 { };
struct input_IN2 { };
struct output_OUT { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<input_IN1> { using T = Number; };
template<> struct ValueType<input_IN2> { using T = Number; };
template<> struct ValueType<output_OUT> { using T = Number; };

struct ContextObject {
    Node* _node;

    Number _input_IN1;
    Number _input_IN2;

};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            " input_IN1 input_IN2" \
            " output_OUT");
}

template<> Number getValue<input_IN1>(Context ctx) {
    return ctx->_input_IN1;
}
template<> Number getValue<input_IN2>(Context ctx) {
    return ctx->_input_IN2;
}
template<> Number getValue<output_OUT>(Context ctx) {
    return ctx->_node->output_OUT;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            "");
    return false;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_OUT");
}

template<> void emitValue<output_OUT>(Context ctx, Number val) {
    ctx->_node->output_OUT = val;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

void evaluate(Context ctx) {
    auto x = getValue<input_IN1>(ctx);
    auto y = getValue<input_IN2>(ctx);
    emitValue<output_OUT>(ctx, x + y);
}

} // namespace xod__core__add

//-----------------------------------------------------------------------------
// xod/core/if-else(number) implementation
//-----------------------------------------------------------------------------
namespace xod__core__if_else__number {

//#pragma XOD dirtieness disable

struct State {
};

struct Node {
    Number output_R;
    State state;
};

struct input_COND { };
struct input_T { };
struct input_F { };
struct output_R { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<input_COND> { using T = Logic; };
template<> struct ValueType<input_T> { using T = Number; };
template<> struct ValueType<input_F> { using T = Number; };
template<> struct ValueType<output_R> { using T = Number; };

struct ContextObject {
    Node* _node;

    Logic _input_COND;
    Number _input_T;
    Number _input_F;

};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            " input_COND input_T input_F" \
            " output_R");
}

template<> Logic getValue<input_COND>(Context ctx) {
    return ctx->_input_COND;
}
template<> Number getValue<input_T>(Context ctx) {
    return ctx->_input_T;
}
template<> Number getValue<input_F>(Context ctx) {
    return ctx->_input_F;
}
template<> Number getValue<output_R>(Context ctx) {
    return ctx->_node->output_R;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            "");
    return false;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_R");
}

template<> void emitValue<output_R>(Context ctx, Number val) {
    ctx->_node->output_R = val;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

void evaluate(Context ctx) {
    auto cond = getValue<input_COND>(ctx);
    auto trueVal = getValue<input_T>(ctx);
    auto falseVal = getValue<input_F>(ctx);
    emitValue<output_R>(ctx, cond ? trueVal : falseVal);
}

} // namespace xod__core__if_else__number

//-----------------------------------------------------------------------------
// xod/core/equal(number) implementation
//-----------------------------------------------------------------------------
namespace xod__core__equal__number {

//#pragma XOD dirtieness disable

struct State {
};

struct Node {
    Logic output_OUT;
    State state;
};

struct input_IN1 { };
struct input_IN2 { };
struct output_OUT { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<input_IN1> { using T = Number; };
template<> struct ValueType<input_IN2> { using T = Number; };
template<> struct ValueType<output_OUT> { using T = Logic; };

struct ContextObject {
    Node* _node;

    Number _input_IN1;
    Number _input_IN2;

};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            " input_IN1 input_IN2" \
            " output_OUT");
}

template<> Number getValue<input_IN1>(Context ctx) {
    return ctx->_input_IN1;
}
template<> Number getValue<input_IN2>(Context ctx) {
    return ctx->_input_IN2;
}
template<> Logic getValue<output_OUT>(Context ctx) {
    return ctx->_node->output_OUT;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            "");
    return false;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_OUT");
}

template<> void emitValue<output_OUT>(Context ctx, Logic val) {
    ctx->_node->output_OUT = val;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

void evaluate(Context ctx) {
    auto lhs = getValue<input_IN1>(ctx);
    auto rhs = getValue<input_IN2>(ctx);
    emitValue<output_OUT>(ctx, lhs == rhs);
}

} // namespace xod__core__equal__number

//-----------------------------------------------------------------------------
// xod/core/buffer(number) implementation
//-----------------------------------------------------------------------------
namespace xod__core__buffer__number {

struct State {
};

struct Node {
    Number output_MEM;
    State state;
};

struct input_NEW { };
struct input_UPD { };
struct output_MEM { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<input_NEW> { using T = Number; };
template<> struct ValueType<input_UPD> { using T = Logic; };
template<> struct ValueType<output_MEM> { using T = Number; };

struct ContextObject {
    Node* _node;

    Number _input_NEW;
    Logic _input_UPD;

    bool _isInputDirty_UPD;

    bool _isOutputDirty_MEM : 1;
};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            " input_NEW input_UPD" \
            " output_MEM");
}

template<> Number getValue<input_NEW>(Context ctx) {
    return ctx->_input_NEW;
}
template<> Logic getValue<input_UPD>(Context ctx) {
    return ctx->_input_UPD;
}
template<> Number getValue<output_MEM>(Context ctx) {
    return ctx->_node->output_MEM;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            " input_UPD");
    return false;
}

template<> bool isInputDirty<input_UPD>(Context ctx) {
    return ctx->_isInputDirty_UPD;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_MEM");
}

template<> void emitValue<output_MEM>(Context ctx, Number val) {
    ctx->_node->output_MEM = val;
    ctx->_isOutputDirty_MEM = true;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

void evaluate(Context ctx) {
    if (!isInputDirty<input_UPD>(ctx))
        return;

    emitValue<output_MEM>(ctx, getValue<input_NEW>(ctx));
}

} // namespace xod__core__buffer__number

//-----------------------------------------------------------------------------
// xod/stream/pass-if(number) implementation
//-----------------------------------------------------------------------------
namespace xod__stream__pass_if__number {

struct State {
};

struct Node {
    Number output_OUT1;
    Logic output_OUT2;
    State state;
};

struct input_IN1 { };
struct input_IN2 { };
struct input_COND { };
struct output_OUT1 { };
struct output_OUT2 { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<input_IN1> { using T = Number; };
template<> struct ValueType<input_IN2> { using T = Logic; };
template<> struct ValueType<input_COND> { using T = Logic; };
template<> struct ValueType<output_OUT1> { using T = Number; };
template<> struct ValueType<output_OUT2> { using T = Logic; };

struct ContextObject {
    Node* _node;

    Number _input_IN1;
    Logic _input_IN2;
    Logic _input_COND;

    bool _isInputDirty_IN2;

    bool _isOutputDirty_OUT1 : 1;
    bool _isOutputDirty_OUT2 : 1;
};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            " input_IN1 input_IN2 input_COND" \
            " output_OUT1 output_OUT2");
}

template<> Number getValue<input_IN1>(Context ctx) {
    return ctx->_input_IN1;
}
template<> Logic getValue<input_IN2>(Context ctx) {
    return ctx->_input_IN2;
}
template<> Logic getValue<input_COND>(Context ctx) {
    return ctx->_input_COND;
}
template<> Number getValue<output_OUT1>(Context ctx) {
    return ctx->_node->output_OUT1;
}
template<> Logic getValue<output_OUT2>(Context ctx) {
    return ctx->_node->output_OUT2;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            " input_IN2");
    return false;
}

template<> bool isInputDirty<input_IN2>(Context ctx) {
    return ctx->_isInputDirty_IN2;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_OUT1 output_OUT2");
}

template<> void emitValue<output_OUT1>(Context ctx, Number val) {
    ctx->_node->output_OUT1 = val;
    ctx->_isOutputDirty_OUT1 = true;
}
template<> void emitValue<output_OUT2>(Context ctx, Logic val) {
    ctx->_node->output_OUT2 = val;
    ctx->_isOutputDirty_OUT2 = true;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

void evaluate(Context ctx) {
    if (!getValue<input_COND>(ctx))
        return;

    if (!isInputDirty<input_IN2>(ctx))
        return;

    emitValue<output_OUT1>(ctx, getValue<input_IN1>(ctx));
    emitValue<output_OUT2>(ctx, 1);
}

} // namespace xod__stream__pass_if__number

//-----------------------------------------------------------------------------
// xod/core/defer(number) implementation
//-----------------------------------------------------------------------------
namespace xod__core__defer__number {

//#pragma XOD error_catch enable
//#pragma XOD error_raise enable

struct State {
    bool shouldRaiseAtTheNextDeferOnlyRun = false;
};

union NodeErrors {
    struct {
        bool output_OUT : 1;
    };

    ErrorFlags flags;
};

struct Node {
    NodeErrors errors;
    TimeMs timeoutAt;
    Number output_OUT;
    State state;
};

struct input_IN { };
struct output_OUT { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<input_IN> { using T = Number; };
template<> struct ValueType<output_OUT> { using T = Number; };

struct ContextObject {
    Node* _node;
    uint8_t _error_input_IN;

    Number _input_IN;

    bool _isOutputDirty_OUT : 1;
};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            " input_IN" \
            " output_OUT");
}

template<> Number getValue<input_IN>(Context ctx) {
    return ctx->_input_IN;
}
template<> Number getValue<output_OUT>(Context ctx) {
    return ctx->_node->output_OUT;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            "");
    return false;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_OUT");
}

template<> void emitValue<output_OUT>(Context ctx, Number val) {
    ctx->_node->output_OUT = val;
    ctx->_isOutputDirty_OUT = true;
    if (isEarlyDeferPass()) ctx->_node->errors.output_OUT = false;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

template<typename OutputT> void raiseError(Context ctx) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_OUT");
}

template<> void raiseError<output_OUT>(Context ctx) {
    ctx->_node->errors.output_OUT = true;
    ctx->_isOutputDirty_OUT = true;
}

void raiseError(Context ctx) {
    ctx->_node->errors.output_OUT = true;
    ctx->_isOutputDirty_OUT = true;
}

template<typename InputT> uint8_t getError(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            " input_IN");
    return 0;
}

template<> uint8_t getError<input_IN>(Context ctx) {
    return ctx->_error_input_IN;
}

void evaluate(Context ctx) {
    auto state = getState(ctx);

    if (isEarlyDeferPass()) {
        if (state->shouldRaiseAtTheNextDeferOnlyRun) {
            raiseError<output_OUT>(ctx);
            state->shouldRaiseAtTheNextDeferOnlyRun = false;
        } else {
            emitValue<output_OUT>(ctx, getValue<output_OUT>(ctx));
        }
    } else {
        if (getError<input_IN>(ctx)) {
            state->shouldRaiseAtTheNextDeferOnlyRun = true;
        } else {
            // save the value for reemission on deferred-only evaluation pass
            emitValue<output_OUT>(ctx, getValue<input_IN>(ctx));
        }

        setTimeout(ctx, 0);
    }
}

} // namespace xod__core__defer__number

//-----------------------------------------------------------------------------
// xod/core/defer(boolean) implementation
//-----------------------------------------------------------------------------
namespace xod__core__defer__boolean {

//#pragma XOD error_catch enable
//#pragma XOD error_raise enable

struct State {
    bool shouldRaiseAtTheNextDeferOnlyRun = false;
};

union NodeErrors {
    struct {
        bool output_OUT : 1;
    };

    ErrorFlags flags;
};

struct Node {
    NodeErrors errors;
    TimeMs timeoutAt;
    Logic output_OUT;
    State state;
};

struct input_IN { };
struct output_OUT { };

template<typename PinT> struct ValueType { using T = void; };
template<> struct ValueType<input_IN> { using T = Logic; };
template<> struct ValueType<output_OUT> { using T = Logic; };

struct ContextObject {
    Node* _node;
    uint8_t _error_input_IN;

    Logic _input_IN;

    bool _isOutputDirty_OUT : 1;
};

using Context = ContextObject*;

template<typename PinT> typename ValueType<PinT>::T getValue(Context ctx) {
    static_assert(always_false<PinT>::value,
            "Invalid pin descriptor. Expected one of:" \
            " input_IN" \
            " output_OUT");
}

template<> Logic getValue<input_IN>(Context ctx) {
    return ctx->_input_IN;
}
template<> Logic getValue<output_OUT>(Context ctx) {
    return ctx->_node->output_OUT;
}

template<typename InputT> bool isInputDirty(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            "");
    return false;
}

template<typename OutputT> void emitValue(Context ctx, typename ValueType<OutputT>::T val) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_OUT");
}

template<> void emitValue<output_OUT>(Context ctx, Logic val) {
    ctx->_node->output_OUT = val;
    ctx->_isOutputDirty_OUT = true;
    if (isEarlyDeferPass()) ctx->_node->errors.output_OUT = false;
}

State* getState(Context ctx) {
    return &ctx->_node->state;
}

template<typename OutputT> void raiseError(Context ctx) {
    static_assert(always_false<OutputT>::value,
            "Invalid output descriptor. Expected one of:" \
            " output_OUT");
}

template<> void raiseError<output_OUT>(Context ctx) {
    ctx->_node->errors.output_OUT = true;
    ctx->_isOutputDirty_OUT = true;
}

void raiseError(Context ctx) {
    ctx->_node->errors.output_OUT = true;
    ctx->_isOutputDirty_OUT = true;
}

template<typename InputT> uint8_t getError(Context ctx) {
    static_assert(always_false<InputT>::value,
            "Invalid input descriptor. Expected one of:" \
            " input_IN");
    return 0;
}

template<> uint8_t getError<input_IN>(Context ctx) {
    return ctx->_error_input_IN;
}

void evaluate(Context ctx) {
    auto state = getState(ctx);

    if (isEarlyDeferPass()) {
        if (state->shouldRaiseAtTheNextDeferOnlyRun) {
            raiseError<output_OUT>(ctx);
            state->shouldRaiseAtTheNextDeferOnlyRun = false;
        } else {
            emitValue<output_OUT>(ctx, getValue<output_OUT>(ctx));
        }
    } else {
        if (getError<input_IN>(ctx)) {
            state->shouldRaiseAtTheNextDeferOnlyRun = true;
        } else {
            // save the value for reemission on deferred-only evaluation pass
            emitValue<output_OUT>(ctx, getValue<input_IN>(ctx));
        }

        setTimeout(ctx, 0);
    }
}

} // namespace xod__core__defer__boolean

} // namespace xod


/*=============================================================================
 *
 *
 * Main loop components
 *
 *
 =============================================================================*/

namespace xod {

// Define/allocate persistent storages (state, timeout, output data) for all nodes
#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"

constexpr Number node_0_output_OUT = 3;

constexpr Number node_1_output_OUT = 1;

constexpr Number node_2_output_OUT = 1;

constexpr Number node_3_output_OUT = 5;

constexpr Number node_4_output_OUT = .1;

constexpr Logic node_5_output_OUT = false;

constexpr Number node_6_output_VAL = 1000;

constexpr Number node_7_output_VAL = 0;

constexpr Number node_8_output_VAL = 0;

constexpr Logic node_9_output_TICK = false;

constexpr Logic node_10_output_MEM = false;

constexpr Logic node_11_output_OUT = false;

constexpr Logic node_12_output_OUT = false;

constexpr Logic node_13_output_OUT = false;

constexpr Number node_14_output_OUT = 0;

constexpr Logic node_15_output_MEM = false;

constexpr Logic node_16_output_OUT = false;

constexpr Number node_17_output_OUT = 0;

constexpr Logic node_18_output_MEM = false;

constexpr Logic node_19_output_OUT = false;

constexpr Number node_20_output_OUT = 0;

constexpr Number node_21_output_OUT = 0;

constexpr Number node_22_output_OUT = 0;

constexpr Number node_23_output_OUT = 0;

constexpr Number node_24_output_OUT = 0;

constexpr Number node_25_output_R = 0;

constexpr Logic node_26_output_OUT = false;

constexpr Number node_27_output_R = 0;

constexpr Number node_28_output_MEM = 0;

constexpr Logic node_29_output_OUT = false;

constexpr Number node_30_output_MEM = 0;

constexpr Logic node_31_output_MEM = true;

constexpr Number node_32_output_OUT = 0;

constexpr Number node_33_output_OUT1 = 0;
constexpr Logic node_33_output_OUT2 = false;

constexpr Number node_34_output_OUT = 0;

constexpr Number node_35_output_OUT = 0;

constexpr Logic node_36_output_OUT = false;

#pragma GCC diagnostic pop

struct TransactionState {
    bool node_0_isNodeDirty : 1;
    bool node_0_isOutputDirty_OUT : 1;
    bool node_1_isNodeDirty : 1;
    bool node_1_isOutputDirty_OUT : 1;
    bool node_2_isNodeDirty : 1;
    bool node_2_isOutputDirty_OUT : 1;
    bool node_3_isNodeDirty : 1;
    bool node_3_isOutputDirty_OUT : 1;
    bool node_4_isNodeDirty : 1;
    bool node_4_isOutputDirty_OUT : 1;
    bool node_5_isNodeDirty : 1;
    bool node_5_isOutputDirty_OUT : 1;
    bool node_9_isNodeDirty : 1;
    bool node_9_isOutputDirty_TICK : 1;
    bool node_9_hasUpstreamError : 1;
    bool node_10_isNodeDirty : 1;
    bool node_10_isOutputDirty_MEM : 1;
    bool node_10_hasUpstreamError : 1;
    bool node_11_isNodeDirty : 1;
    bool node_11_isOutputDirty_OUT : 1;
    bool node_11_hasUpstreamError : 1;
    bool node_12_isNodeDirty : 1;
    bool node_12_isOutputDirty_OUT : 1;
    bool node_12_hasUpstreamError : 1;
    bool node_13_isNodeDirty : 1;
    bool node_13_isOutputDirty_OUT : 1;
    bool node_13_hasUpstreamError : 1;
    bool node_14_isNodeDirty : 1;
    bool node_14_isOutputDirty_OUT : 1;
    bool node_14_hasUpstreamError : 1;
    bool node_15_isNodeDirty : 1;
    bool node_15_isOutputDirty_MEM : 1;
    bool node_15_hasUpstreamError : 1;
    bool node_16_isNodeDirty : 1;
    bool node_16_isOutputDirty_OUT : 1;
    bool node_16_hasUpstreamError : 1;
    bool node_17_isNodeDirty : 1;
    bool node_17_isOutputDirty_OUT : 1;
    bool node_17_hasUpstreamError : 1;
    bool node_18_isNodeDirty : 1;
    bool node_18_isOutputDirty_MEM : 1;
    bool node_18_hasUpstreamError : 1;
    bool node_19_isNodeDirty : 1;
    bool node_19_isOutputDirty_OUT : 1;
    bool node_19_hasUpstreamError : 1;
    bool node_20_isNodeDirty : 1;
    bool node_20_isOutputDirty_OUT : 1;
    bool node_20_hasUpstreamError : 1;
    bool node_21_isNodeDirty : 1;
    bool node_21_isOutputDirty_OUT : 1;
    bool node_21_hasUpstreamError : 1;
    bool node_22_isNodeDirty : 1;
    bool node_22_isOutputDirty_OUT : 1;
    bool node_22_hasUpstreamError : 1;
    bool node_23_isNodeDirty : 1;
    bool node_23_isOutputDirty_OUT : 1;
    bool node_23_hasUpstreamError : 1;
    bool node_24_isNodeDirty : 1;
    bool node_24_isOutputDirty_OUT : 1;
    bool node_24_hasUpstreamError : 1;
    bool node_25_isNodeDirty : 1;
    bool node_25_isOutputDirty_R : 1;
    bool node_25_hasUpstreamError : 1;
    bool node_26_isNodeDirty : 1;
    bool node_26_isOutputDirty_OUT : 1;
    bool node_26_hasUpstreamError : 1;
    bool node_27_isNodeDirty : 1;
    bool node_27_isOutputDirty_R : 1;
    bool node_27_hasUpstreamError : 1;
    bool node_28_isNodeDirty : 1;
    bool node_28_isOutputDirty_MEM : 1;
    bool node_28_hasUpstreamError : 1;
    bool node_29_isNodeDirty : 1;
    bool node_29_isOutputDirty_OUT : 1;
    bool node_29_hasUpstreamError : 1;
    bool node_30_isNodeDirty : 1;
    bool node_30_isOutputDirty_MEM : 1;
    bool node_30_hasUpstreamError : 1;
    bool node_31_isNodeDirty : 1;
    bool node_31_isOutputDirty_MEM : 1;
    bool node_31_hasUpstreamError : 1;
    bool node_32_isNodeDirty : 1;
    bool node_32_isOutputDirty_OUT : 1;
    bool node_32_hasUpstreamError : 1;
    bool node_33_isNodeDirty : 1;
    bool node_33_isOutputDirty_OUT1 : 1;
    bool node_33_isOutputDirty_OUT2 : 1;
    bool node_33_hasUpstreamError : 1;
    bool node_34_isNodeDirty : 1;
    bool node_34_isOutputDirty_OUT : 1;
    bool node_34_hasUpstreamError : 1;
    bool node_35_isNodeDirty : 1;
    bool node_35_isOutputDirty_OUT : 1;
    bool node_35_hasUpstreamError : 1;
    bool node_36_isNodeDirty : 1;
    bool node_36_isOutputDirty_OUT : 1;
    bool node_36_hasUpstreamError : 1;
    TransactionState() {
        node_0_isNodeDirty = true;
        node_0_isOutputDirty_OUT = true;
        node_1_isNodeDirty = true;
        node_1_isOutputDirty_OUT = true;
        node_2_isNodeDirty = true;
        node_2_isOutputDirty_OUT = true;
        node_3_isNodeDirty = true;
        node_3_isOutputDirty_OUT = true;
        node_4_isNodeDirty = true;
        node_4_isOutputDirty_OUT = true;
        node_5_isNodeDirty = true;
        node_5_isOutputDirty_OUT = false;
        node_9_isNodeDirty = true;
        node_9_isOutputDirty_TICK = false;
        node_10_isNodeDirty = true;
        node_10_isOutputDirty_MEM = true;
        node_11_isNodeDirty = true;
        node_12_isNodeDirty = true;
        node_12_isOutputDirty_OUT = false;
        node_13_isNodeDirty = true;
        node_13_isOutputDirty_OUT = false;
        node_14_isNodeDirty = true;
        node_14_isOutputDirty_OUT = true;
        node_15_isNodeDirty = true;
        node_15_isOutputDirty_MEM = true;
        node_16_isNodeDirty = true;
        node_16_isOutputDirty_OUT = false;
        node_17_isNodeDirty = true;
        node_17_isOutputDirty_OUT = true;
        node_18_isNodeDirty = true;
        node_18_isOutputDirty_MEM = true;
        node_19_isNodeDirty = true;
        node_19_isOutputDirty_OUT = false;
        node_20_isNodeDirty = true;
        node_21_isNodeDirty = true;
        node_22_isNodeDirty = true;
        node_23_isNodeDirty = true;
        node_24_isNodeDirty = true;
        node_25_isNodeDirty = true;
        node_26_isNodeDirty = true;
        node_27_isNodeDirty = true;
        node_28_isNodeDirty = true;
        node_28_isOutputDirty_MEM = true;
        node_29_isNodeDirty = true;
        node_29_isOutputDirty_OUT = false;
        node_30_isNodeDirty = true;
        node_30_isOutputDirty_MEM = true;
        node_31_isNodeDirty = true;
        node_31_isOutputDirty_MEM = true;
        node_32_isNodeDirty = true;
        node_33_isNodeDirty = true;
        node_33_isOutputDirty_OUT1 = true;
        node_33_isOutputDirty_OUT2 = false;
        node_34_isNodeDirty = true;
        node_34_isOutputDirty_OUT = true;
        node_35_isNodeDirty = true;
        node_35_isOutputDirty_OUT = true;
        node_36_isNodeDirty = true;
        node_36_isOutputDirty_OUT = true;
    }
};

TransactionState g_transaction;

xod__debug__tweak_number::Node node_0 = {
    node_0_output_OUT, // output OUT default
    xod__debug__tweak_number::State() // state default
};
xod__debug__tweak_number::Node node_1 = {
    node_1_output_OUT, // output OUT default
    xod__debug__tweak_number::State() // state default
};
xod__debug__tweak_number::Node node_2 = {
    node_2_output_OUT, // output OUT default
    xod__debug__tweak_number::State() // state default
};
xod__debug__tweak_number::Node node_3 = {
    node_3_output_OUT, // output OUT default
    xod__debug__tweak_number::State() // state default
};
xod__debug__tweak_number::Node node_4 = {
    node_4_output_OUT, // output OUT default
    xod__debug__tweak_number::State() // state default
};
xod__debug__tweak_pulse::Node node_5 = {
    node_5_output_OUT, // output OUT default
    xod__debug__tweak_pulse::State() // state default
};
xod__core__clock::Node node_9 = {
    0, // timeoutAt
    node_9_output_TICK, // output TICK default
    xod__core__clock::State() // state default
};
xod__core__flip_flop::Node node_10 = {
    node_10_output_MEM, // output MEM default
    xod__core__flip_flop::State() // state default
};
xod__core__not::Node node_11 = {
    node_11_output_OUT, // output OUT default
    xod__core__not::State() // state default
};
xod__core__pulse_on_true::Node node_12 = {
    node_12_output_OUT, // output OUT default
    xod__core__pulse_on_true::State() // state default
};
xod__core__cast_to_pulse__boolean::Node node_13 = {
    node_13_output_OUT, // output OUT default
    xod__core__cast_to_pulse__boolean::State() // state default
};
xod__core__count::Node node_14 = {
    node_14_output_OUT, // output OUT default
    xod__core__count::State() // state default
};
xod__core__flip_flop::Node node_15 = {
    node_15_output_MEM, // output MEM default
    xod__core__flip_flop::State() // state default
};
xod__core__any::Node node_16 = {
    node_16_output_OUT, // output OUT default
    xod__core__any::State() // state default
};
xod__core__count::Node node_17 = {
    node_17_output_OUT, // output OUT default
    xod__core__count::State() // state default
};
xod__core__flip_flop::Node node_18 = {
    node_18_output_MEM, // output MEM default
    xod__core__flip_flop::State() // state default
};
xod__core__any::Node node_19 = {
    node_19_output_OUT, // output OUT default
    xod__core__any::State() // state default
};
xod__core__multiply::Node node_20 = {
    node_20_output_OUT, // output OUT default
    xod__core__multiply::State() // state default
};
xod__core__multiply::Node node_21 = {
    node_21_output_OUT, // output OUT default
    xod__core__multiply::State() // state default
};
xod__core__add::Node node_22 = {
    node_22_output_OUT, // output OUT default
    xod__core__add::State() // state default
};
xod__core__add::Node node_23 = {
    node_23_output_OUT, // output OUT default
    xod__core__add::State() // state default
};
xod__core__add::Node node_24 = {
    node_24_output_OUT, // output OUT default
    xod__core__add::State() // state default
};
xod__core__if_else__number::Node node_25 = {
    node_25_output_R, // output R default
    xod__core__if_else__number::State() // state default
};
xod__core__equal__number::Node node_26 = {
    node_26_output_OUT, // output OUT default
    xod__core__equal__number::State() // state default
};
xod__core__if_else__number::Node node_27 = {
    node_27_output_R, // output R default
    xod__core__if_else__number::State() // state default
};
xod__core__buffer__number::Node node_28 = {
    node_28_output_MEM, // output MEM default
    xod__core__buffer__number::State() // state default
};
xod__core__pulse_on_true::Node node_29 = {
    node_29_output_OUT, // output OUT default
    xod__core__pulse_on_true::State() // state default
};
xod__core__buffer__number::Node node_30 = {
    node_30_output_MEM, // output MEM default
    xod__core__buffer__number::State() // state default
};
xod__core__flip_flop::Node node_31 = {
    node_31_output_MEM, // output MEM default
    xod__core__flip_flop::State() // state default
};
xod__core__add::Node node_32 = {
    node_32_output_OUT, // output OUT default
    xod__core__add::State() // state default
};
xod__stream__pass_if__number::Node node_33 = {
    node_33_output_OUT1, // output OUT1 default
    node_33_output_OUT2, // output OUT2 default
    xod__stream__pass_if__number::State() // state default
};
xod__core__defer__number::Node node_34 = {
    false, // OUT has no errors on start
    0, // timeoutAt
    node_34_output_OUT, // output OUT default
    xod__core__defer__number::State() // state default
};
xod__core__defer__number::Node node_35 = {
    false, // OUT has no errors on start
    0, // timeoutAt
    node_35_output_OUT, // output OUT default
    xod__core__defer__number::State() // state default
};
xod__core__defer__boolean::Node node_36 = {
    false, // OUT has no errors on start
    0, // timeoutAt
    node_36_output_OUT, // output OUT default
    xod__core__defer__boolean::State() // state default
};

#if defined(XOD_DEBUG) || defined(XOD_SIMULATION)
namespace detail {
void handleTweaks() {
    if (XOD_DEBUG_SERIAL.available() > 0 && XOD_DEBUG_SERIAL.find("+XOD:", 5)) {
        int tweakedNodeId = XOD_DEBUG_SERIAL.parseInt();

        switch (tweakedNodeId) {
            case 0:
                {
                    node_0.output_OUT = XOD_DEBUG_SERIAL.parseFloat();
                    // to run evaluate and mark all downstream nodes as dirty
                    g_transaction.node_0_isNodeDirty = true;
                    g_transaction.node_0_isOutputDirty_OUT = true;
                }
                break;

            case 1:
                {
                    node_1.output_OUT = XOD_DEBUG_SERIAL.parseFloat();
                    // to run evaluate and mark all downstream nodes as dirty
                    g_transaction.node_1_isNodeDirty = true;
                    g_transaction.node_1_isOutputDirty_OUT = true;
                }
                break;

            case 2:
                {
                    node_2.output_OUT = XOD_DEBUG_SERIAL.parseFloat();
                    // to run evaluate and mark all downstream nodes as dirty
                    g_transaction.node_2_isNodeDirty = true;
                    g_transaction.node_2_isOutputDirty_OUT = true;
                }
                break;

            case 3:
                {
                    node_3.output_OUT = XOD_DEBUG_SERIAL.parseFloat();
                    // to run evaluate and mark all downstream nodes as dirty
                    g_transaction.node_3_isNodeDirty = true;
                    g_transaction.node_3_isOutputDirty_OUT = true;
                }
                break;

            case 4:
                {
                    node_4.output_OUT = XOD_DEBUG_SERIAL.parseFloat();
                    // to run evaluate and mark all downstream nodes as dirty
                    g_transaction.node_4_isNodeDirty = true;
                    g_transaction.node_4_isOutputDirty_OUT = true;
                }
                break;

            case 5:
                {
                    node_5.output_OUT = 1;
                    // to run evaluate and mark all downstream nodes as dirty
                    g_transaction.node_5_isNodeDirty = true;
                    g_transaction.node_5_isOutputDirty_OUT = true;
                }
                break;

        }

        XOD_DEBUG_SERIAL.find('\n');
    }
}
} // namespace detail
#endif

void handleDefers() {
    {
        if (g_transaction.node_34_isNodeDirty) {
            bool error_input_IN = false;
            error_input_IN |= node_36.errors.output_OUT;

            XOD_TRACE_F("Trigger defer node #");
            XOD_TRACE_LN(34);

            xod__core__defer__number::ContextObject ctxObj;
            ctxObj._node = &node_34;

            ctxObj._input_IN = node_28.output_MEM;

            ctxObj._error_input_IN = error_input_IN;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = false;

            xod__core__defer__number::NodeErrors previousErrors = node_34.errors;

            xod__core__defer__number::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_34_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            if (previousErrors.flags != node_34.errors.flags) {
                detail::printErrorToDebugSerial(34, node_34.errors.flags);

                // if an error was just raised or cleared from an output,
                // mark nearest downstream error catchers as dirty
                if (node_34.errors.output_OUT != previousErrors.output_OUT) {
                    g_transaction.node_34_isNodeDirty = true;
                }

            }

            // mark downstream nodes dirty
            g_transaction.node_22_isNodeDirty |= g_transaction.node_34_isOutputDirty_OUT || node_34.errors.flags;

            g_transaction.node_34_isNodeDirty = false;
            detail::clearTimeout(&node_34);
        }

        // propagate the error hold by the defer node
        if (node_34.errors.flags) {
            if (node_34.errors.output_OUT) {
                g_transaction.node_22_hasUpstreamError = true;
            }
        }
    }
    {
        if (g_transaction.node_35_isNodeDirty) {
            bool error_input_IN = false;
            error_input_IN |= node_36.errors.output_OUT;

            XOD_TRACE_F("Trigger defer node #");
            XOD_TRACE_LN(35);

            xod__core__defer__number::ContextObject ctxObj;
            ctxObj._node = &node_35;

            ctxObj._input_IN = node_30.output_MEM;

            ctxObj._error_input_IN = error_input_IN;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = false;

            xod__core__defer__number::NodeErrors previousErrors = node_35.errors;

            xod__core__defer__number::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_35_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            if (previousErrors.flags != node_35.errors.flags) {
                detail::printErrorToDebugSerial(35, node_35.errors.flags);

                // if an error was just raised or cleared from an output,
                // mark nearest downstream error catchers as dirty
                if (node_35.errors.output_OUT != previousErrors.output_OUT) {
                    g_transaction.node_35_isNodeDirty = true;
                }

            }

            // mark downstream nodes dirty
            g_transaction.node_24_isNodeDirty |= g_transaction.node_35_isOutputDirty_OUT || node_35.errors.flags;

            g_transaction.node_35_isNodeDirty = false;
            detail::clearTimeout(&node_35);
        }

        // propagate the error hold by the defer node
        if (node_35.errors.flags) {
            if (node_35.errors.output_OUT) {
                g_transaction.node_24_hasUpstreamError = true;
            }
        }
    }
    {
        if (g_transaction.node_36_isNodeDirty) {

            XOD_TRACE_F("Trigger defer node #");
            XOD_TRACE_LN(36);

            xod__core__defer__boolean::ContextObject ctxObj;
            ctxObj._node = &node_36;

            ctxObj._input_IN = node_31.output_MEM;

            ctxObj._error_input_IN = 0;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = false;

            xod__core__defer__boolean::NodeErrors previousErrors = node_36.errors;

            xod__core__defer__boolean::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_36_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            if (previousErrors.flags != node_36.errors.flags) {
                detail::printErrorToDebugSerial(36, node_36.errors.flags);

                // if an error was just raised or cleared from an output,
                // mark nearest downstream error catchers as dirty
                if (node_36.errors.output_OUT != previousErrors.output_OUT) {
                    g_transaction.node_35_isNodeDirty = true;
                    g_transaction.node_36_isNodeDirty = true;
                    g_transaction.node_34_isNodeDirty = true;
                }

            }

            // mark downstream nodes dirty
            g_transaction.node_9_isNodeDirty |= g_transaction.node_36_isOutputDirty_OUT || node_36.errors.flags;

            g_transaction.node_36_isNodeDirty = false;
            detail::clearTimeout(&node_36);
        }

        // propagate the error hold by the defer node
        if (node_36.errors.flags) {
            if (node_36.errors.output_OUT) {
                g_transaction.node_9_hasUpstreamError = true;
            }
        }
    }
}

void runTransaction() {
    g_transactionTime = millis();

    XOD_TRACE_F("Transaction started, t=");
    XOD_TRACE_LN(g_transactionTime);

#if defined(XOD_DEBUG) || defined(XOD_SIMULATION)
    detail::handleTweaks();
#endif

    // Check for timeouts
    g_transaction.node_9_isNodeDirty |= detail::isTimedOut(&node_9);
    g_transaction.node_34_isNodeDirty |= detail::isTimedOut(&node_34);
    g_transaction.node_35_isNodeDirty |= detail::isTimedOut(&node_35);
    g_transaction.node_36_isNodeDirty |= detail::isTimedOut(&node_36);

    // defer-* nodes are always at the very bottom of the graph, so no one will
    // recieve values emitted by them. We must evaluate them before everybody
    // else to give them a chance to emit values.
    //
    // If trigerred, keep only output dirty, not the node itself, so it will
    // evaluate on the regular pass only if it receives a new value again.
    if (!isSettingUp()) {
        g_isEarlyDeferPass = true;
        handleDefers();
        g_isEarlyDeferPass = false;
    }

    // Evaluate all dirty nodes
    { // xod__debug__tweak_number #0
        if (g_transaction.node_0_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(0);

            xod__debug__tweak_number::ContextObject ctxObj;
            ctxObj._node = &node_0;

            // copy data from upstream nodes into context

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = g_transaction.node_0_isOutputDirty_OUT;

            xod__debug__tweak_number::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_0_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            // mark downstream nodes dirty
            g_transaction.node_21_isNodeDirty |= g_transaction.node_0_isOutputDirty_OUT;
        }

    }
    { // xod__debug__tweak_number #1
        if (g_transaction.node_1_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(1);

            xod__debug__tweak_number::ContextObject ctxObj;
            ctxObj._node = &node_1;

            // copy data from upstream nodes into context

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = g_transaction.node_1_isOutputDirty_OUT;

            xod__debug__tweak_number::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_1_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            // mark downstream nodes dirty
            g_transaction.node_17_isNodeDirty |= g_transaction.node_1_isOutputDirty_OUT;
        }

    }
    { // xod__debug__tweak_number #2
        if (g_transaction.node_2_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(2);

            xod__debug__tweak_number::ContextObject ctxObj;
            ctxObj._node = &node_2;

            // copy data from upstream nodes into context

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = g_transaction.node_2_isOutputDirty_OUT;

            xod__debug__tweak_number::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_2_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            // mark downstream nodes dirty
            g_transaction.node_14_isNodeDirty |= g_transaction.node_2_isOutputDirty_OUT;
        }

    }
    { // xod__debug__tweak_number #3
        if (g_transaction.node_3_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(3);

            xod__debug__tweak_number::ContextObject ctxObj;
            ctxObj._node = &node_3;

            // copy data from upstream nodes into context

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = g_transaction.node_3_isOutputDirty_OUT;

            xod__debug__tweak_number::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_3_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            // mark downstream nodes dirty
            g_transaction.node_20_isNodeDirty |= g_transaction.node_3_isOutputDirty_OUT;
        }

    }
    { // xod__debug__tweak_number #4
        if (g_transaction.node_4_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(4);

            xod__debug__tweak_number::ContextObject ctxObj;
            ctxObj._node = &node_4;

            // copy data from upstream nodes into context

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = g_transaction.node_4_isOutputDirty_OUT;

            xod__debug__tweak_number::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_4_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            // mark downstream nodes dirty
            g_transaction.node_9_isNodeDirty |= g_transaction.node_4_isOutputDirty_OUT;
        }

    }
    { // xod__debug__tweak_pulse #5
        if (g_transaction.node_5_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(5);

            xod__debug__tweak_pulse::ContextObject ctxObj;
            ctxObj._node = &node_5;

            // copy data from upstream nodes into context

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = g_transaction.node_5_isOutputDirty_OUT;

            xod__debug__tweak_pulse::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_5_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            // mark downstream nodes dirty
            g_transaction.node_31_isNodeDirty |= g_transaction.node_5_isOutputDirty_OUT;
            g_transaction.node_19_isNodeDirty |= g_transaction.node_5_isOutputDirty_OUT;
            g_transaction.node_18_isNodeDirty |= g_transaction.node_5_isOutputDirty_OUT;
            g_transaction.node_16_isNodeDirty |= g_transaction.node_5_isOutputDirty_OUT;
            g_transaction.node_15_isNodeDirty |= g_transaction.node_5_isOutputDirty_OUT;
            g_transaction.node_9_isNodeDirty |= g_transaction.node_5_isOutputDirty_OUT;
            g_transaction.node_17_isNodeDirty |= g_transaction.node_5_isOutputDirty_OUT;
            g_transaction.node_14_isNodeDirty |= g_transaction.node_5_isOutputDirty_OUT;
            g_transaction.node_10_isNodeDirty |= g_transaction.node_5_isOutputDirty_OUT;
        }

    }
    { // xod__core__clock #9

        if (g_transaction.node_9_hasUpstreamError) {
            g_transaction.node_33_hasUpstreamError = true;
            g_transaction.node_10_hasUpstreamError = true;
        } else if (g_transaction.node_9_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(9);

            xod__core__clock::ContextObject ctxObj;
            ctxObj._node = &node_9;

            // copy data from upstream nodes into context
            ctxObj._input_EN = node_36.output_OUT;
            ctxObj._input_IVAL = node_4.output_OUT;
            ctxObj._input_RST = node_5.output_OUT;

            ctxObj._isInputDirty_EN = g_transaction.node_36_isOutputDirty_OUT;
            ctxObj._isInputDirty_RST = g_transaction.node_5_isOutputDirty_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_TICK = false;

            xod__core__clock::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_9_isOutputDirty_TICK = ctxObj._isOutputDirty_TICK;

            // mark downstream nodes dirty
            g_transaction.node_33_isNodeDirty |= g_transaction.node_9_isOutputDirty_TICK;
            g_transaction.node_10_isNodeDirty |= g_transaction.node_9_isOutputDirty_TICK;
        }

    }
    { // xod__core__flip_flop #10

        if (g_transaction.node_10_hasUpstreamError) {
            g_transaction.node_11_hasUpstreamError = true;
            g_transaction.node_12_hasUpstreamError = true;
        } else if (g_transaction.node_10_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(10);

            xod__core__flip_flop::ContextObject ctxObj;
            ctxObj._node = &node_10;

            // copy data from upstream nodes into context
            ctxObj._input_TGL = node_9.output_TICK;
            ctxObj._input_RST = node_5.output_OUT;

            ctxObj._isInputDirty_SET = false;
            ctxObj._isInputDirty_TGL = g_transaction.node_9_isOutputDirty_TICK;
            ctxObj._isInputDirty_RST = g_transaction.node_5_isOutputDirty_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_MEM = false;

            xod__core__flip_flop::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_10_isOutputDirty_MEM = ctxObj._isOutputDirty_MEM;

            // mark downstream nodes dirty
            g_transaction.node_11_isNodeDirty |= g_transaction.node_10_isOutputDirty_MEM;
            g_transaction.node_12_isNodeDirty |= g_transaction.node_10_isOutputDirty_MEM;
        }

    }
    { // xod__core__not #11

        if (g_transaction.node_11_hasUpstreamError) {
            g_transaction.node_13_hasUpstreamError = true;
        } else if (g_transaction.node_11_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(11);

            xod__core__not::ContextObject ctxObj;
            ctxObj._node = &node_11;

            // copy data from upstream nodes into context
            ctxObj._input_IN = node_10.output_MEM;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`

            xod__core__not::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction

            // mark downstream nodes dirty
            g_transaction.node_13_isNodeDirty = true;
        }

    }
    { // xod__core__pulse_on_true #12

        if (g_transaction.node_12_hasUpstreamError) {
            g_transaction.node_15_hasUpstreamError = true;
            g_transaction.node_16_hasUpstreamError = true;
            g_transaction.node_14_hasUpstreamError = true;
        } else if (g_transaction.node_12_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(12);

            xod__core__pulse_on_true::ContextObject ctxObj;
            ctxObj._node = &node_12;

            // copy data from upstream nodes into context
            ctxObj._input_IN = node_10.output_MEM;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = false;

            xod__core__pulse_on_true::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_12_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            // mark downstream nodes dirty
            g_transaction.node_15_isNodeDirty |= g_transaction.node_12_isOutputDirty_OUT;
            g_transaction.node_16_isNodeDirty |= g_transaction.node_12_isOutputDirty_OUT;
            g_transaction.node_14_isNodeDirty |= g_transaction.node_12_isOutputDirty_OUT;
        }

    }
    { // xod__core__cast_to_pulse__boolean #13

        if (g_transaction.node_13_hasUpstreamError) {
            g_transaction.node_18_hasUpstreamError = true;
            g_transaction.node_19_hasUpstreamError = true;
            g_transaction.node_17_hasUpstreamError = true;
        } else if (g_transaction.node_13_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(13);

            xod__core__cast_to_pulse__boolean::ContextObject ctxObj;
            ctxObj._node = &node_13;

            // copy data from upstream nodes into context
            ctxObj._input_IN = node_11.output_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = false;

            xod__core__cast_to_pulse__boolean::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_13_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            // mark downstream nodes dirty
            g_transaction.node_18_isNodeDirty |= g_transaction.node_13_isOutputDirty_OUT;
            g_transaction.node_19_isNodeDirty |= g_transaction.node_13_isOutputDirty_OUT;
            g_transaction.node_17_isNodeDirty |= g_transaction.node_13_isOutputDirty_OUT;
        }

    }
    { // xod__core__count #14

        if (g_transaction.node_14_hasUpstreamError) {
            g_transaction.node_20_hasUpstreamError = true;
        } else if (g_transaction.node_14_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(14);

            xod__core__count::ContextObject ctxObj;
            ctxObj._node = &node_14;

            // copy data from upstream nodes into context
            ctxObj._input_STEP = node_2.output_OUT;
            ctxObj._input_INC = node_12.output_OUT;
            ctxObj._input_RST = node_5.output_OUT;

            ctxObj._isInputDirty_INC = g_transaction.node_12_isOutputDirty_OUT;
            ctxObj._isInputDirty_RST = g_transaction.node_5_isOutputDirty_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = false;

            xod__core__count::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_14_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            // mark downstream nodes dirty
            g_transaction.node_20_isNodeDirty |= g_transaction.node_14_isOutputDirty_OUT;
        }

    }
    { // xod__core__flip_flop #15

        if (g_transaction.node_15_hasUpstreamError) {
            g_transaction.node_25_hasUpstreamError = true;
        } else if (g_transaction.node_15_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(15);

            xod__core__flip_flop::ContextObject ctxObj;
            ctxObj._node = &node_15;

            // copy data from upstream nodes into context
            ctxObj._input_SET = node_12.output_OUT;
            ctxObj._input_RST = node_5.output_OUT;

            ctxObj._isInputDirty_TGL = false;
            ctxObj._isInputDirty_SET = g_transaction.node_12_isOutputDirty_OUT;
            ctxObj._isInputDirty_RST = g_transaction.node_5_isOutputDirty_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_MEM = false;

            xod__core__flip_flop::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_15_isOutputDirty_MEM = ctxObj._isOutputDirty_MEM;

            // mark downstream nodes dirty
            g_transaction.node_25_isNodeDirty |= g_transaction.node_15_isOutputDirty_MEM;
        }

    }
    { // xod__core__any #16

        if (g_transaction.node_16_hasUpstreamError) {
            g_transaction.node_28_hasUpstreamError = true;
        } else if (g_transaction.node_16_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(16);

            xod__core__any::ContextObject ctxObj;
            ctxObj._node = &node_16;

            // copy data from upstream nodes into context
            ctxObj._input_IN1 = node_12.output_OUT;
            ctxObj._input_IN2 = node_5.output_OUT;

            ctxObj._isInputDirty_IN1 = g_transaction.node_12_isOutputDirty_OUT;
            ctxObj._isInputDirty_IN2 = g_transaction.node_5_isOutputDirty_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = false;

            xod__core__any::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_16_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            // mark downstream nodes dirty
            g_transaction.node_28_isNodeDirty |= g_transaction.node_16_isOutputDirty_OUT;
        }

    }
    { // xod__core__count #17

        if (g_transaction.node_17_hasUpstreamError) {
            g_transaction.node_21_hasUpstreamError = true;
        } else if (g_transaction.node_17_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(17);

            xod__core__count::ContextObject ctxObj;
            ctxObj._node = &node_17;

            // copy data from upstream nodes into context
            ctxObj._input_STEP = node_1.output_OUT;
            ctxObj._input_INC = node_13.output_OUT;
            ctxObj._input_RST = node_5.output_OUT;

            ctxObj._isInputDirty_INC = g_transaction.node_13_isOutputDirty_OUT;
            ctxObj._isInputDirty_RST = g_transaction.node_5_isOutputDirty_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = false;

            xod__core__count::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_17_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            // mark downstream nodes dirty
            g_transaction.node_21_isNodeDirty |= g_transaction.node_17_isOutputDirty_OUT;
        }

    }
    { // xod__core__flip_flop #18

        if (g_transaction.node_18_hasUpstreamError) {
            g_transaction.node_27_hasUpstreamError = true;
        } else if (g_transaction.node_18_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(18);

            xod__core__flip_flop::ContextObject ctxObj;
            ctxObj._node = &node_18;

            // copy data from upstream nodes into context
            ctxObj._input_SET = node_13.output_OUT;
            ctxObj._input_RST = node_5.output_OUT;

            ctxObj._isInputDirty_TGL = false;
            ctxObj._isInputDirty_SET = g_transaction.node_13_isOutputDirty_OUT;
            ctxObj._isInputDirty_RST = g_transaction.node_5_isOutputDirty_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_MEM = false;

            xod__core__flip_flop::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_18_isOutputDirty_MEM = ctxObj._isOutputDirty_MEM;

            // mark downstream nodes dirty
            g_transaction.node_27_isNodeDirty |= g_transaction.node_18_isOutputDirty_MEM;
        }

    }
    { // xod__core__any #19

        if (g_transaction.node_19_hasUpstreamError) {
            g_transaction.node_30_hasUpstreamError = true;
        } else if (g_transaction.node_19_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(19);

            xod__core__any::ContextObject ctxObj;
            ctxObj._node = &node_19;

            // copy data from upstream nodes into context
            ctxObj._input_IN1 = node_13.output_OUT;
            ctxObj._input_IN2 = node_5.output_OUT;

            ctxObj._isInputDirty_IN1 = g_transaction.node_13_isOutputDirty_OUT;
            ctxObj._isInputDirty_IN2 = g_transaction.node_5_isOutputDirty_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = false;

            xod__core__any::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_19_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            // mark downstream nodes dirty
            g_transaction.node_30_isNodeDirty |= g_transaction.node_19_isOutputDirty_OUT;
        }

    }
    { // xod__core__multiply #20

        if (g_transaction.node_20_hasUpstreamError) {
            g_transaction.node_23_hasUpstreamError = true;
            g_transaction.node_22_hasUpstreamError = true;
        } else if (g_transaction.node_20_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(20);

            xod__core__multiply::ContextObject ctxObj;
            ctxObj._node = &node_20;

            // copy data from upstream nodes into context
            ctxObj._input_IN1 = node_3.output_OUT;
            ctxObj._input_IN2 = node_14.output_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`

            xod__core__multiply::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction

            // mark downstream nodes dirty
            g_transaction.node_23_isNodeDirty = true;
            g_transaction.node_22_isNodeDirty = true;
        }

    }
    { // xod__core__multiply #21

        if (g_transaction.node_21_hasUpstreamError) {
            g_transaction.node_23_hasUpstreamError = true;
            g_transaction.node_24_hasUpstreamError = true;
        } else if (g_transaction.node_21_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(21);

            xod__core__multiply::ContextObject ctxObj;
            ctxObj._node = &node_21;

            // copy data from upstream nodes into context
            ctxObj._input_IN1 = node_0.output_OUT;
            ctxObj._input_IN2 = node_17.output_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`

            xod__core__multiply::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction

            // mark downstream nodes dirty
            g_transaction.node_23_isNodeDirty = true;
            g_transaction.node_24_isNodeDirty = true;
        }

    }
    { // xod__core__add #22

        if (g_transaction.node_22_hasUpstreamError) {
            g_transaction.node_25_hasUpstreamError = true;
        } else if (g_transaction.node_22_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(22);

            xod__core__add::ContextObject ctxObj;
            ctxObj._node = &node_22;

            // copy data from upstream nodes into context
            ctxObj._input_IN1 = node_34.output_OUT;
            ctxObj._input_IN2 = node_20.output_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`

            xod__core__add::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction

            // mark downstream nodes dirty
            g_transaction.node_25_isNodeDirty = true;
        }

    }
    { // xod__core__add #23

        if (g_transaction.node_23_hasUpstreamError) {
            g_transaction.node_26_hasUpstreamError = true;
            g_transaction.node_33_hasUpstreamError = true;
        } else if (g_transaction.node_23_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(23);

            xod__core__add::ContextObject ctxObj;
            ctxObj._node = &node_23;

            // copy data from upstream nodes into context
            ctxObj._input_IN1 = node_21.output_OUT;
            ctxObj._input_IN2 = node_20.output_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`

            xod__core__add::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction

            // mark downstream nodes dirty
            g_transaction.node_26_isNodeDirty = true;
            g_transaction.node_33_isNodeDirty = true;
        }

    }
    { // xod__core__add #24

        if (g_transaction.node_24_hasUpstreamError) {
            g_transaction.node_27_hasUpstreamError = true;
        } else if (g_transaction.node_24_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(24);

            xod__core__add::ContextObject ctxObj;
            ctxObj._node = &node_24;

            // copy data from upstream nodes into context
            ctxObj._input_IN1 = node_35.output_OUT;
            ctxObj._input_IN2 = node_21.output_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`

            xod__core__add::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction

            // mark downstream nodes dirty
            g_transaction.node_27_isNodeDirty = true;
        }

    }
    { // xod__core__if_else__number #25

        if (g_transaction.node_25_hasUpstreamError) {
            g_transaction.node_28_hasUpstreamError = true;
        } else if (g_transaction.node_25_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(25);

            xod__core__if_else__number::ContextObject ctxObj;
            ctxObj._node = &node_25;

            // copy data from upstream nodes into context
            ctxObj._input_COND = node_15.output_MEM;
            ctxObj._input_T = node_22.output_OUT;
            ctxObj._input_F = node_8_output_VAL;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`

            xod__core__if_else__number::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction

            // mark downstream nodes dirty
            g_transaction.node_28_isNodeDirty = true;
        }

    }
    { // xod__core__equal__number #26

        if (g_transaction.node_26_hasUpstreamError) {
            g_transaction.node_29_hasUpstreamError = true;
        } else if (g_transaction.node_26_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(26);

            xod__core__equal__number::ContextObject ctxObj;
            ctxObj._node = &node_26;

            // copy data from upstream nodes into context
            ctxObj._input_IN1 = node_23.output_OUT;
            ctxObj._input_IN2 = node_6_output_VAL;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`

            xod__core__equal__number::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction

            // mark downstream nodes dirty
            g_transaction.node_29_isNodeDirty = true;
        }

    }
    { // xod__core__if_else__number #27

        if (g_transaction.node_27_hasUpstreamError) {
            g_transaction.node_30_hasUpstreamError = true;
        } else if (g_transaction.node_27_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(27);

            xod__core__if_else__number::ContextObject ctxObj;
            ctxObj._node = &node_27;

            // copy data from upstream nodes into context
            ctxObj._input_COND = node_18.output_MEM;
            ctxObj._input_T = node_24.output_OUT;
            ctxObj._input_F = node_7_output_VAL;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`

            xod__core__if_else__number::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction

            // mark downstream nodes dirty
            g_transaction.node_30_isNodeDirty = true;
        }

    }
    { // xod__core__buffer__number #28

        if (g_transaction.node_28_hasUpstreamError) {
            g_transaction.node_34_hasUpstreamError = true;
            g_transaction.node_32_hasUpstreamError = true;
        } else if (g_transaction.node_28_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(28);

            xod__core__buffer__number::ContextObject ctxObj;
            ctxObj._node = &node_28;

            // copy data from upstream nodes into context
            ctxObj._input_NEW = node_25.output_R;
            ctxObj._input_UPD = node_16.output_OUT;

            ctxObj._isInputDirty_UPD = g_transaction.node_16_isOutputDirty_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_MEM = false;

            xod__core__buffer__number::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_28_isOutputDirty_MEM = ctxObj._isOutputDirty_MEM;

            // mark downstream nodes dirty
            g_transaction.node_34_isNodeDirty |= g_transaction.node_28_isOutputDirty_MEM;
            g_transaction.node_32_isNodeDirty |= g_transaction.node_28_isOutputDirty_MEM;
        }

    }
    { // xod__core__pulse_on_true #29

        if (g_transaction.node_29_hasUpstreamError) {
            g_transaction.node_31_hasUpstreamError = true;
        } else if (g_transaction.node_29_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(29);

            xod__core__pulse_on_true::ContextObject ctxObj;
            ctxObj._node = &node_29;

            // copy data from upstream nodes into context
            ctxObj._input_IN = node_26.output_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = false;

            xod__core__pulse_on_true::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_29_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            // mark downstream nodes dirty
            g_transaction.node_31_isNodeDirty |= g_transaction.node_29_isOutputDirty_OUT;
        }

    }
    { // xod__core__buffer__number #30

        if (g_transaction.node_30_hasUpstreamError) {
            g_transaction.node_35_hasUpstreamError = true;
            g_transaction.node_32_hasUpstreamError = true;
        } else if (g_transaction.node_30_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(30);

            xod__core__buffer__number::ContextObject ctxObj;
            ctxObj._node = &node_30;

            // copy data from upstream nodes into context
            ctxObj._input_NEW = node_27.output_R;
            ctxObj._input_UPD = node_19.output_OUT;

            ctxObj._isInputDirty_UPD = g_transaction.node_19_isOutputDirty_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_MEM = false;

            xod__core__buffer__number::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_30_isOutputDirty_MEM = ctxObj._isOutputDirty_MEM;

            // mark downstream nodes dirty
            g_transaction.node_35_isNodeDirty |= g_transaction.node_30_isOutputDirty_MEM;
            g_transaction.node_32_isNodeDirty |= g_transaction.node_30_isOutputDirty_MEM;
        }

    }
    { // xod__core__flip_flop #31

        if (g_transaction.node_31_hasUpstreamError) {
            g_transaction.node_36_hasUpstreamError = true;
            g_transaction.node_33_hasUpstreamError = true;
        } else if (g_transaction.node_31_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(31);

            xod__core__flip_flop::ContextObject ctxObj;
            ctxObj._node = &node_31;

            // copy data from upstream nodes into context
            ctxObj._input_SET = node_5.output_OUT;
            ctxObj._input_RST = node_29.output_OUT;

            ctxObj._isInputDirty_TGL = false;
            ctxObj._isInputDirty_SET = g_transaction.node_5_isOutputDirty_OUT;
            ctxObj._isInputDirty_RST = g_transaction.node_29_isOutputDirty_OUT;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_MEM = false;

            xod__core__flip_flop::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_31_isOutputDirty_MEM = ctxObj._isOutputDirty_MEM;

            // mark downstream nodes dirty
            g_transaction.node_36_isNodeDirty |= g_transaction.node_31_isOutputDirty_MEM;
            g_transaction.node_33_isNodeDirty |= g_transaction.node_31_isOutputDirty_MEM;
        }

    }
    { // xod__core__add #32

        if (g_transaction.node_32_hasUpstreamError) {
        } else if (g_transaction.node_32_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(32);

            xod__core__add::ContextObject ctxObj;
            ctxObj._node = &node_32;

            // copy data from upstream nodes into context
            ctxObj._input_IN1 = node_30.output_MEM;
            ctxObj._input_IN2 = node_28.output_MEM;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`

            xod__core__add::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction

            // mark downstream nodes dirty
        }

    }
    { // xod__stream__pass_if__number #33

        if (g_transaction.node_33_hasUpstreamError) {
        } else if (g_transaction.node_33_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(33);

            xod__stream__pass_if__number::ContextObject ctxObj;
            ctxObj._node = &node_33;

            // copy data from upstream nodes into context
            ctxObj._input_IN1 = node_23.output_OUT;
            ctxObj._input_IN2 = node_9.output_TICK;
            ctxObj._input_COND = node_31.output_MEM;

            ctxObj._isInputDirty_IN2 = g_transaction.node_9_isOutputDirty_TICK;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT1 = false;
            ctxObj._isOutputDirty_OUT2 = false;

            xod__stream__pass_if__number::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_33_isOutputDirty_OUT1 = ctxObj._isOutputDirty_OUT1;
            g_transaction.node_33_isOutputDirty_OUT2 = ctxObj._isOutputDirty_OUT2;

            // mark downstream nodes dirty
        }

    }
    { // xod__core__defer__number #34

        if (g_transaction.node_34_isNodeDirty) {
            bool error_input_IN = false;
            error_input_IN |= node_36.errors.output_OUT;
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(34);

            xod__core__defer__number::ContextObject ctxObj;
            ctxObj._node = &node_34;

            ctxObj._error_input_IN = error_input_IN;

            // copy data from upstream nodes into context
            ctxObj._input_IN = node_28.output_MEM;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = false;

            xod__core__defer__number::NodeErrors previousErrors = node_34.errors;

            xod__core__defer__number::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_34_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            if (previousErrors.flags != node_34.errors.flags) {
                detail::printErrorToDebugSerial(34, node_34.errors.flags);

                // if an error was just raised or cleared from an output,
                // mark nearest downstream error catchers as dirty
                if (node_34.errors.output_OUT != previousErrors.output_OUT) {
                    g_transaction.node_34_isNodeDirty = true;
                }

                // if a pulse output was cleared from error, mark downstream nodes as dirty
                // (no matter if a pulse was emitted or not)
            }

            // mark downstream nodes dirty
            g_transaction.node_22_isNodeDirty |= g_transaction.node_34_isOutputDirty_OUT;
        }

        // propagate errors hold by the node outputs
        if (node_34.errors.flags) {
            if (node_34.errors.output_OUT) {
                g_transaction.node_22_hasUpstreamError = true;
            }
        }
    }
    { // xod__core__defer__number #35

        if (g_transaction.node_35_isNodeDirty) {
            bool error_input_IN = false;
            error_input_IN |= node_36.errors.output_OUT;
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(35);

            xod__core__defer__number::ContextObject ctxObj;
            ctxObj._node = &node_35;

            ctxObj._error_input_IN = error_input_IN;

            // copy data from upstream nodes into context
            ctxObj._input_IN = node_30.output_MEM;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = false;

            xod__core__defer__number::NodeErrors previousErrors = node_35.errors;

            xod__core__defer__number::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_35_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            if (previousErrors.flags != node_35.errors.flags) {
                detail::printErrorToDebugSerial(35, node_35.errors.flags);

                // if an error was just raised or cleared from an output,
                // mark nearest downstream error catchers as dirty
                if (node_35.errors.output_OUT != previousErrors.output_OUT) {
                    g_transaction.node_35_isNodeDirty = true;
                }

                // if a pulse output was cleared from error, mark downstream nodes as dirty
                // (no matter if a pulse was emitted or not)
            }

            // mark downstream nodes dirty
            g_transaction.node_24_isNodeDirty |= g_transaction.node_35_isOutputDirty_OUT;
        }

        // propagate errors hold by the node outputs
        if (node_35.errors.flags) {
            if (node_35.errors.output_OUT) {
                g_transaction.node_24_hasUpstreamError = true;
            }
        }
    }
    { // xod__core__defer__boolean #36
        if (g_transaction.node_36_isNodeDirty) {
            XOD_TRACE_F("Eval node #");
            XOD_TRACE_LN(36);

            xod__core__defer__boolean::ContextObject ctxObj;
            ctxObj._node = &node_36;

            ctxObj._error_input_IN = 0;

            // copy data from upstream nodes into context
            ctxObj._input_IN = node_31.output_MEM;

            // initialize temporary output dirtyness state in the context,
            // where it can be modified from `raiseError` and `emitValue`
            ctxObj._isOutputDirty_OUT = false;

            xod__core__defer__boolean::NodeErrors previousErrors = node_36.errors;

            xod__core__defer__boolean::evaluate(&ctxObj);

            // transfer possibly modified dirtiness state from context to g_transaction
            g_transaction.node_36_isOutputDirty_OUT = ctxObj._isOutputDirty_OUT;

            if (previousErrors.flags != node_36.errors.flags) {
                detail::printErrorToDebugSerial(36, node_36.errors.flags);

                // if an error was just raised or cleared from an output,
                // mark nearest downstream error catchers as dirty
                if (node_36.errors.output_OUT != previousErrors.output_OUT) {
                    g_transaction.node_35_isNodeDirty = true;
                    g_transaction.node_36_isNodeDirty = true;
                    g_transaction.node_34_isNodeDirty = true;
                }

                // if a pulse output was cleared from error, mark downstream nodes as dirty
                // (no matter if a pulse was emitted or not)
            }

            // mark downstream nodes dirty
            g_transaction.node_9_isNodeDirty |= g_transaction.node_36_isOutputDirty_OUT;
        }

        // propagate errors hold by the node outputs
        if (node_36.errors.flags) {
            if (node_36.errors.output_OUT) {
                g_transaction.node_9_hasUpstreamError = true;
            }
        }
    }

    // Clear dirtieness and timeouts for all nodes and pins
    memset(&g_transaction, 0, sizeof(g_transaction));

    detail::clearStaleTimeout(&node_9);
    detail::clearStaleTimeout(&node_34);
    detail::clearStaleTimeout(&node_35);
    detail::clearStaleTimeout(&node_36);

    XOD_TRACE_F("Transaction completed, t=");
    XOD_TRACE_LN(millis());
}

} // namespace xod
